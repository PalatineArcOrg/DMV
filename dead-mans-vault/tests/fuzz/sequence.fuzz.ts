// Phase 4 — P9: stateful / instruction-SEQUENCE fuzzer (the state machine itself).
// See docs/STRESS-TESTING-PLAN.md §Phase 4 and docs/FUZZ-HARNESS-PLAN.md §Phase 4.
//
// Everything in P1–P8 fuzzes INPUTS to a FIXED crank order. P9 fuzzes the ORDER:
// each run builds ONE random vault, then applies a random-length sequence of
// instructions in random order by random signers, interleaved with random clock
// warps (sometimes crossing the deadline). Every step is ALLOWED to fail — an
// illegal ordering reverting is EXPECTED and correct — but after EVERY step we
// re-read on-chain state and assert the GLOBAL invariants. The point is that NO
// random ordering can violate a global invariant.
//
// Invariants asserted after every step (against a JS shadow model):
//   #1 executed monotonic (once true, never observed false again)
//   #2 masks monotonic (sol_paid_mask / token_dist.paid_mask / asset_plan.paid_mask
//      bits only ever get SET; a token_dist that is closed+reopened resets cleanly)
//   #3 no post-deadline owner mutation (a succeeding owner op ⇒ clock < deadline)
//   #4 no over-distribution (per-beneficiary SOL/token bounded by frozen snapshot)
//   #5 SOL conservation (vault == baseline + externalNet − paidToBenes − bountyPaid;
//      + exact token conservation Σbenef+vaultAta+ownerAta == original balance)
//   #6 core-PDA close safety (close_executed_vault_by_owner only succeeds when
//      executed && open_token_dists == 0)
//   #7 ordering gates (a crank op whose hard precondition is unmet MUST revert)
//
// Memory (per docs/FUZZ-HARNESS-PLAN.md): one LiteSVM vault per run, gcAfter,
// endOnFailure, byte-offset readers (never the anchor BN), send() expires the
// blockhash before each submit, LOW numRuns (sequences are heavy). Own file/process.

import { expect } from "chai";
import fc from "fast-check";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  BN,
  TOKEN_PROGRAM_ID,
  program,
  airdrop,
  bal,
  rentFor,
  accountDataLen,
  readU64LE,
  readI64LE,
  readU32LE,
  readU16LE,
  readU8,
  OFF_HEARTBEAT_LAST,
  OFF_EXEC_SOL_SNAPSHOT,
  OFF_TOKENDIST_SNAPSHOT,
  warpClockTo,
  send,
  gcAfter,
  isClosed,
  tokenBal,
  SENTINEL_MINT,
  tokenDistPda,
  createAtaIx,
} from "./harness";
import {
  INTERVAL,
  GRACE,
  MAX_BOUNTY,
  sharesArb,
  largestShareIdx,
  makeVault,
  fundVaultToken,
  makeBeneAtas,
} from "./setup";

// --- byte offsets (after the 8-byte anchor discriminator) --------------------
// ExecutionLog: sol_snapshot @40 (given), sol_paid_mask @48 (u32).
const OFF_EXEC_SOL_MASK = 48;
// TokenDist: snapshot @72 (given), paid_mask @80 (u32).
const OFF_TOKENDIST_MASK = 80;
// VaultConfig: heartbeat_interval @72 (i64), grace_period @80 (i64). The post-Vec
// flags start at 92 + n*34 (8 disc + 32 owner + 32 agent + 8 interval + 8 grace +
// 4 vec-len + n*34 beneficiaries): executed @base, active @+1, is_mutable @+19,
// has_asset_plan @+20, open_token_dists @+21 (u16).
const OFF_VAULT_INTERVAL = 72;
const OFF_VAULT_GRACE = 80;
const vaultFlagBase = (n: number) => 92 + n * 34;
// AssetPlan: paid_mask (u64) sits after 8 disc + 32 vault + 4 vec-len + a*42.
const OFF_PLAN_MASK = (a: number) => 44 + a * 42;

// Weighted op alphabet — biased toward reaching execution (warp / deposit / begin /
// solShares / finalize appear multiple times) so a meaningful fraction of runs
// actually distribute rather than just bouncing off ordering gates.
//
// The op sequence is a SHUFFLE of a per-run "recipe": a guaranteed core multiset
// (2× each of the happy-path steps, gated to whatever the vault holds) plus noise
// ops (owner mutations + deposits). Shuffling keeps the ORDER fully random — every
// out-of-order gate is still exercised on the many mis-ordered attempts — but
// guaranteeing the core is PRESENT means a meaningful fraction of shuffles contain
// a valid completion order, so runs actually finalize/close rather than just
// bouncing off ordering gates. An independent per-step draw almost never lines up
// begin→shares→specifics→finalize→close and left token/plan runs never completing.
const OWNER_MUTS = new Set([
  "heartbeat", "update", "withdrawSol", "withdrawTok", "rotate", "revoke", "updatePlan", "clearPlan",
]);
const NOISE = ["heartbeat", "update", "withdrawSol", "withdrawTok", "rotate", "revoke", "updatePlan", "clearPlan", "deposit", "deposit"];
const SLOTS = 34; // upper bound on recipe length; prio/params arrays are this long

// Per-slot params: which signer cranks, a warp size + big flag, a deposit/withdraw
// amount, and an assignment index. `op` is assigned from the shuffled recipe, not here.
const paramArb = fc.record({
  signer: fc.integer({ min: 0, max: 2 }),
  amt: fc.integer({ min: 0, max: 100_000_000 }),
  warp: fc.integer({ min: 0, max: 2_000_000 }),
  big: fc.integer({ min: 0, max: 9 }).map((x) => x < 7),
});

const cfgArb = fc.integer({ min: 1, max: 4 }).chain((n) =>
  fc.record({
    n: fc.constant(n),
    shares: sharesArb(n),
    bounty: fc.integer({ min: 0, max: Math.min(20_000_000, MAX_BOUNTY) }),
    extra: fc.integer({ min: 2_000_000, max: 2_000_000_000 }),
    // bias toward holding a token so a meaningful fraction of runs exercise the
    // token_dist begin/close/mask machinery (true ~2/3 of the time).
    hasToken: fc.integer({ min: 0, max: 2 }).map((x) => x !== 0),
    decimals: fc.constantFrom(0, 6, 9),
    tokenBal: fc.bigInt({ min: 1n, max: 1_000_000_000_000n }),
    // plans (specific bequests) are kept ~1/3 so plenty of runs are plain enough to
    // actually finalize; the rest still exercise begin_token_dist / masks / closes.
    planTok: fc.integer({ min: 0, max: 2 }).map((x) => x === 0),
    tokFrac: fc.integer({ min: 1, max: 80 }),
    idxTok: fc.integer({ min: 0, max: n - 1 }),
    planSol: fc.integer({ min: 0, max: 2 }).map((x) => x === 0),
    solFrac: fc.integer({ min: 1, max: 40 }),
    idxSol: fc.integer({ min: 0, max: n - 1 }),
    // 0–2 guaranteed big warps BEFORE the shuffled recipe. ≥1 crosses the deadline
    // up front (execution-heavy run: owner mutations land frozen, cranks can proceed);
    // 0 leaves the whole sequence in fully-random temporal order relative to the
    // deadline (owner muts / revoke may fire pre-deadline). ~2/3 of runs cross early.
    leadWarps: fc.integer({ min: 0, max: 2 }),
    // prio shuffles the recipe (sort by prio); params supplies per-slot randomness.
    prio: fc.array(fc.integer({ min: 0, max: 1_000_000 }), { minLength: SLOTS, maxLength: SLOTS }),
    params: fc.array(paramArb, { minLength: SLOTS, maxLength: SLOTS }),
  })
);

type Prm = { signer: number; amt: number; warp: number; big: boolean };
type Cfg = {
  n: number; shares: number[]; bounty: number; extra: number;
  hasToken: boolean; decimals: number; tokenBal: bigint;
  planTok: boolean; tokFrac: number; idxTok: number;
  planSol: boolean; solFrac: number; idxSol: number;
  leadWarps: number; prio: number[]; params: Prm[];
};

describe("fuzz — instruction-sequence state machine (LiteSVM + fast-check)", () => {
  it("P9 sequence: no random ordering violates a global invariant", async function () {
    this.timeout(600_000);
    await fc.assert(
      fc.asyncProperty(cfgArb, gcAfter(async (c: Cfg) => {
        // ---- deterministic setup ------------------------------------------------
        const aTok = c.hasToken && c.planTok ? (c.tokenBal * BigInt(c.tokFrac)) / 100n : 0n;
        const aSol = c.planSol ? (BigInt(c.extra) * BigInt(c.solFrac)) / 100n : 0n;
        const planTok = aTok >= 1n; // token specific present
        const planSol = aSol >= 1n; // sol specific present
        const bounty = BigInt(c.bounty);
        const initDeposit = bounty + aSol + BigInt(c.extra);

        const V = await makeVault(c.n, c.shares, bounty, initDeposit);
        const { svm, owner, agent, cranker, benes, pdas, assetPlan } = V;

        // signer pool for permissionless cranks (each must fund fees + new-PDA rent).
        const cranker2 = Keypair.generate();
        airdrop(svm, cranker2.publicKey, 2_000_000_000n);
        airdrop(svm, cranker.publicKey, 2_000_000_000n);
        const pool = [cranker, cranker2, owner];
        let currentAgent = agent; // rotate_agent moves this to a fresh keypair

        // optional token: mint held by the vault + beneficiary ATAs + an owner ATA.
        let token: { mint: PublicKey; vaultAta: PublicKey; beneAtas: PublicKey[]; ownerAta: PublicKey } | null = null;
        if (c.hasToken) {
          const { mint, vaultAta } = fundVaultToken(svm, owner, pdas.vault, c.decimals, c.tokenBal);
          const beneAtas = makeBeneAtas(svm, owner, mint, benes.map((b) => b.publicKey));
          const { ata: ownerAta, ix } = createAtaIx(owner.publicKey, owner.publicKey, mint);
          send(svm, new Transaction().add(ix), owner);
          token = { mint, vaultAta, beneAtas, ownerAta };
        }

        // asset plan (created once, at setup) — fixed content so snapshot math is known.
        const asg: Array<{ sentinel: boolean; benefIdx: number; amount: bigint }> = [];
        let jTok = -1, jSol = -1;
        if (planTok && token) { asg.push({ sentinel: false, benefIdx: c.idxTok, amount: aTok }); jTok = asg.length - 1; }
        if (planSol) { asg.push({ sentinel: true, benefIdx: c.idxSol, amount: aSol }); jSol = asg.length - 1; }
        const asgCount = asg.length;
        const hasPlan = asgCount > 0;
        if (hasPlan) {
          send(
            svm,
            await program.methods
              .setAssetPlan(
                asg.map((a) => ({
                  mint: a.sentinel ? SENTINEL_MINT : (token as any).mint,
                  amount: new BN(a.amount.toString()),
                  beneficiaryIndex: a.benefIdx,
                  isNft: false,
                }))
              )
              .accountsPartial({ owner: owner.publicKey, vaultConfig: pdas.vault, heartbeatRecord: pdas.heartbeat, assetPlan, systemProgram: SystemProgram.programId })
              .transaction(),
            owner
          );
        }

        // per-beneficiary specific amounts (for the #4 over-distribution caps).
        const specSol = Array(c.n).fill(0n) as bigint[];
        const specTok = Array(c.n).fill(0n) as bigint[];
        if (jSol >= 0) specSol[asg[jSol].benefIdx] += asg[jSol].amount;
        if (jTok >= 0) specTok[asg[jTok].benefIdx] += asg[jTok].amount;
        const largest = largestShareIdx(c.shares);
        const nB = BigInt(c.n);

        // ---- shadow model / ledger ---------------------------------------------
        const baseline = bal(svm, pdas.vault);            // vault SOL right after setup
        const benInit = benes.map((b) => bal(svm, b.publicKey));
        const originalTokenBal = c.hasToken ? c.tokenBal : 0n;
        let externalNet = 0n;   // Σ deposit/withdraw vault deltas (external, non-distribution)
        let bountyPaid = 0n;    // measured bounty debit at finalize
        let clock = (svm.getClock().unixTimestamp as bigint);
        // guaranteed leading big warps — cross the deadline up front on ~2/3 of runs.
        for (let w = 0; w < Number(c.leadWarps); w++) { clock += BigInt(GRACE + INTERVAL + 7); warpClockTo(svm, clock); }

        let prevExecuted = false;
        let prevSolMask = 0;
        let prevPlanMask = 0;
        let prevTokMask = 0;
        let frozenS: bigint | null = null;   // sol_snapshot (write-once at begin)
        let frozenST: bigint | null = null;  // token residual snapshot (write-once at begin_token_dist)

        const idxAll = benes.map((_, i) => i);
        const attempt = async (txP: Promise<Transaction>, feePayer: Keypair, signers: Keypair[] = []) => {
          let tx: Transaction;
          try { tx = await txP; } catch { return false; }
          try { send(svm, tx, feePayer, signers); return true; } catch { return false; }
        };

        // Build the per-run recipe (guaranteed core + noise), then shuffle by prio.
        const recipe: string[] = ["warp", "warp", "begin", "begin", "solShares", "solShares", "finalize", "finalize", "closeOwner", "closeOwner"];
        if (token) recipe.push("beginTok", "beginTok", "tokShares", "tokShares", "closeTok", "closeTok");
        if (jSol >= 0) recipe.push("specSol", "specSol");
        if (jTok >= 0) recipe.push("specAsset", "specAsset");
        for (const nz of NOISE) recipe.push(nz);
        // Shuffle by prio, with a MILD phase offset that nudges finalize/closes later
        // (jitter range 1e6 ≫ the offsets, so the order stays substantially random and
        // every out-of-order gate is still hit — the offset just lets a fraction of
        // runs reach the terminal closed state instead of never completing the chain).
        const phase = (o: string) => (o === "closeOwner" ? 700_000 : o === "closeTok" ? 500_000 : o === "finalize" ? 300_000 : 0);
        const order = recipe
          .map((rop, i) => ({ rop, prio: (c.prio[i] ?? i) + phase(rop) }))
          .sort((a, b) => a.prio - b.prio)
          .map((x) => x.rop);

        // Live plan flag: hasPlan is a per-run const, but clear_asset_plan closes the
        // AssetPlan mid-run. After a successful clear, the account is GONE — so
        // `planLive = hasPlan && !planCleared` guards every plan read + the plan arg
        // (or the harness reads a closed account / passes a stale PDA and faults).
        let planCleared = false;
        for (let k = 0; k < order.length; k++) {
          if (isClosed(svm, pdas.vault)) break; // vault revoked/owner-closed → nothing left to do

          // Op from the shuffled recipe; per-slot params from the generated array.
          // Capture into locals (never re-read a fast-check field inline).
          const op = order[k];
          const prm = c.params[k] ?? { signer: 0, amt: 0, warp: 0, big: true };
          const sSigner = Number(prm.signer);
          const sAmt = Number(prm.amt);
          const sWarp = Number(prm.warp);
          const sBig = Boolean(prm.big);
          // The index is computed in a plain statement (not inline in the bracket) and
          // clamped with a fallback: the ts-node transpile in this harness was observed
          // to miscompile a modulo written directly inside a `[ ]` index to NaN, so we
          // never rely on a raw `x % n` returning a valid slot from within the bracket.
          const sidx = ((sSigner | 0) % pool.length + pool.length) % pool.length;
          const p = pool[sidx] ?? cranker;
          const td = token ? tokenDistPda(pdas.vault, token.mint) : null;

          // ---- pre-op snapshot of the shadow-relevant on-chain state ------------
          const lastHb = readI64LE(svm, pdas.heartbeat, OFF_HEARTBEAT_LAST);
          const interval = readI64LE(svm, pdas.vault, OFF_VAULT_INTERVAL);
          const grace = readI64LE(svm, pdas.vault, OFF_VAULT_GRACE);
          const deadline = lastHb + interval + grace;
          const base = vaultFlagBase(c.n);
          const execLogExists = !isClosed(svm, pdas.execution);
          const executedBefore = readU8(svm, pdas.vault, base) !== 0;
          const openTokBefore = readU16LE(svm, pdas.vault, base + 21);
          const solMask = execLogExists ? readU32LE(svm, pdas.execution, OFF_EXEC_SOL_MASK) : 0;
          const solMaskFull = solMask === (1 << c.n) - 1;
          // `planLive` (not the per-run `hasPlan` const) — false once clear_asset_plan
          // has closed the AssetPlan mid-run. Every plan read + plan arg below gates on it.
          const planLive = hasPlan && !planCleared;
          const planMask = planLive ? Number(readU64LE(svm, assetPlan, OFF_PLAN_MASK(asgCount))) : 0;
          const planMaskFull = planLive ? planMask === (1 << asgCount) - 1 : true;
          const tokExists = td ? !isClosed(svm, td) : false;
          const tokMask = tokExists ? readU32LE(svm, td!, OFF_TOKENDIST_MASK) : 0;
          const tokMaskFull = tokExists ? tokMask === (1 << c.n) - 1 : false;
          const bitSet = (mask: number, bit: number) => bit >= 0 && (mask & (1 << bit)) !== 0;

          // ---- hard-precondition-violation predicate (op MUST revert if true) ---
          let mustFail = false;
          switch (op) {
            case "begin": mustFail = execLogExists || executedBefore || clock < deadline; break;
            case "beginTok": mustFail = !execLogExists || tokExists; break;
            case "solShares": mustFail = !execLogExists; break;
            case "tokShares": mustFail = !tokExists; break;
            case "specSol": mustFail = !execLogExists || bitSet(planMask, jSol); break;
            case "specAsset": mustFail = !execLogExists || !tokExists || bitSet(planMask, jTok); break;
            case "finalize": mustFail = !execLogExists || executedBefore || !solMaskFull || !planMaskFull; break;
            case "closeTok": mustFail = !tokExists || !tokMaskFull; break;
            case "closeOwner": mustFail = !executedBefore || openTokBefore > 0; break;
            default: mustFail = false;
          }

          const vaultBefore = bal(svm, pdas.vault);
          let ran = true;   // false ⇒ step was a no-op (missing token/plan or a warp)
          let ok = false;

          switch (op) {
            case "warp": {
              clock += BigInt(sBig ? GRACE + INTERVAL + sWarp : sWarp);
              warpClockTo(svm, clock);
              ran = false;
              break;
            }
            case "deposit": {
              ok = await attempt(
                Promise.resolve(new Transaction().add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: pdas.vault, lamports: 1_000_000 + sAmt }))),
                owner
              );
              break;
            }
            case "begin":
              ok = await attempt(
                program.methods.beginExecution().accountsPartial({ payer: p.publicKey, vaultConfig: pdas.vault, heartbeatRecord: pdas.heartbeat, executionLog: pdas.execution, assetPlan: planLive ? assetPlan : null, systemProgram: SystemProgram.programId }).transaction(),
                p
              );
              break;
            case "solShares":
              ok = await attempt(
                program.methods.executeSolShares(Buffer.from(idxAll)).accountsPartial({ payer: p.publicKey, vaultConfig: pdas.vault, executionLog: pdas.execution }).remainingAccounts(benes.map((b) => ({ pubkey: b.publicKey, isWritable: true, isSigner: false }))).transaction(),
                p
              );
              break;
            case "finalize":
              ok = await attempt(
                program.methods.finalizeExecution().accountsPartial({ payer: p.publicKey, vaultConfig: pdas.vault, executionLog: pdas.execution, assetPlan: planLive ? assetPlan : null }).transaction(),
                p
              );
              break;
            case "beginTok":
              if (!token) { ran = false; break; }
              ok = await attempt(
                program.methods.beginTokenDist().accountsPartial({ payer: p.publicKey, vaultConfig: pdas.vault, executionLog: pdas.execution, mint: token.mint, vaultAta: token.vaultAta, assetPlan: planLive ? assetPlan : null, tokenDist: td, systemProgram: SystemProgram.programId }).transaction(),
                p
              );
              break;
            case "tokShares":
              if (!token) { ran = false; break; }
              ok = await attempt(
                program.methods.executeTokenShares(Buffer.from(idxAll)).accountsPartial({ payer: p.publicKey, vaultConfig: pdas.vault, tokenDist: td, mint: token.mint, vaultAta: token.vaultAta, tokenProgram: TOKEN_PROGRAM_ID }).remainingAccounts(token.beneAtas.map((pk) => ({ pubkey: pk, isWritable: true, isSigner: false }))).transaction(),
                p
              );
              break;
            case "specSol":
              if (jSol < 0) { ran = false; break; }
              ok = await attempt(
                program.methods.executeSpecificSol(jSol).accountsPartial({ payer: p.publicKey, vaultConfig: pdas.vault, executionLog: pdas.execution, assetPlan, beneficiary: benes[asg[jSol].benefIdx].publicKey }).transaction(),
                p
              );
              break;
            case "specAsset":
              if (jTok < 0 || !token) { ran = false; break; }
              ok = await attempt(
                program.methods.executeSpecificAsset(jTok).accountsPartial({ payer: p.publicKey, vaultConfig: pdas.vault, executionLog: pdas.execution, assetPlan, mint: token.mint, tokenDist: td, vaultAta: token.vaultAta, beneficiaryAta: token.beneAtas[asg[jTok].benefIdx], tokenProgram: TOKEN_PROGRAM_ID }).transaction(),
                p
              );
              break;
            case "closeTok": {
              if (!token) { ran = false; break; }
              const dust = tokExists ? tokenBal(svm, token.vaultAta) : 0n;
              ok = await attempt(
                program.methods.closeTokenDist().accountsPartial({ payer: p.publicKey, owner: owner.publicKey, vaultConfig: pdas.vault, mint: token.mint, vaultAta: token.vaultAta, tokenDist: td, largestBenefAta: dust > 0n ? token.beneAtas[largest] : null, tokenProgram: TOKEN_PROGRAM_ID }).transaction(),
                p
              );
              break;
            }
            case "closeOwner": {
              const solDust = bal(svm, pdas.vault) - rentFor(svm, accountDataLen(svm, pdas.vault));
              ok = await attempt(
                program.methods.closeExecutedVaultByOwner().accountsPartial({ owner: owner.publicKey, vaultConfig: pdas.vault, heartbeatRecord: pdas.heartbeat, executionLog: pdas.execution, assetPlan: planLive ? assetPlan : null, largestBenef: solDust > 0n ? benes[largest].publicKey : null }).transaction(),
                owner
              );
              break;
            }
            case "heartbeat":
              ok = await attempt(
                program.methods.recordHeartbeat({ activeTap: {} }).accountsPartial({ agent: currentAgent.publicKey, vaultConfig: pdas.vault, heartbeatRecord: pdas.heartbeat }).transaction(),
                owner, [currentAgent]
              );
              break;
            case "update":
              ok = await attempt(
                program.methods.updateVault({ heartbeatInterval: new BN(700_000), gracePeriod: null, beneficiaries: null }).accountsPartial({ owner: owner.publicKey, vaultConfig: pdas.vault, heartbeatRecord: pdas.heartbeat }).transaction(),
                owner
              );
              break;
            case "withdrawSol":
              ok = await attempt(
                program.methods.withdrawSolFromVault(new BN(1_000_000)).accountsPartial({ owner: owner.publicKey, vaultConfig: pdas.vault, heartbeatRecord: pdas.heartbeat }).transaction(),
                owner
              );
              break;
            case "withdrawTok":
              if (!token) { ran = false; break; }
              ok = await attempt(
                program.methods.withdrawFromVault(new BN(1)).accountsPartial({ owner: owner.publicKey, vaultConfig: pdas.vault, heartbeatRecord: pdas.heartbeat, mint: token.mint, sourceTokenAccount: token.vaultAta, destinationTokenAccount: token.ownerAta, tokenProgram: TOKEN_PROGRAM_ID }).transaction(),
                owner
              );
              break;
            case "rotate": {
              const newAgent = Keypair.generate();
              ok = await attempt(
                program.methods.rotateAgent(newAgent.publicKey).accountsPartial({ owner: owner.publicKey, vaultConfig: pdas.vault, heartbeatRecord: pdas.heartbeat }).transaction(),
                owner
              );
              if (ok) currentAgent = newAgent;
              break;
            }
            case "revoke":
              ok = await attempt(
                program.methods.revokeVault().accountsPartial({ owner: owner.publicKey, vaultConfig: pdas.vault, heartbeatRecord: pdas.heartbeat, assetPlan: planLive ? assetPlan : null }).transaction(),
                owner
              );
              break;
            case "updatePlan":
              if (!planLive) { ran = false; break; }
              ok = await attempt(
                program.methods.updateAssetPlan(
                  asg.map((a) => ({ mint: a.sentinel ? SENTINEL_MINT : (token as any).mint, amount: new BN(a.amount.toString()), beneficiaryIndex: a.benefIdx, isNft: false }))
                ).accountsPartial({ owner: owner.publicKey, vaultConfig: pdas.vault, heartbeatRecord: pdas.heartbeat, assetPlan }).transaction(),
                owner
              );
              break;
            case "clearPlan":
              if (!planLive) { ran = false; break; } // no live plan → nothing to clear
              ok = await attempt(
                program.methods.clearAssetPlan().accountsPartial({ owner: owner.publicKey, vaultConfig: pdas.vault, heartbeatRecord: pdas.heartbeat, assetPlan }).transaction(),
                owner
              );
              if (ok) planCleared = true; // AssetPlan closed on-chain — every later plan read/arg must skip it
              break;
          }

          if (!ran) continue; // warp or a no-op (missing token/plan) — no state change

          // ---- ledger updates from this op ---------------------------------------
          if (op === "deposit" || op === "withdrawSol") externalNet += bal(svm, pdas.vault) - vaultBefore;

          const vaultClosedNow = isClosed(svm, pdas.vault);
          // On close, `executed` is unreadable but unchanged: owner-close requires it
          // true, revoke requires it false — so carry executedBefore through the close.
          const executedAfter = vaultClosedNow ? executedBefore : readU8(svm, pdas.vault, base) !== 0;
          if (op === "finalize" && ok && !executedBefore && executedAfter) bountyPaid += vaultBefore - bal(svm, pdas.vault);

          // #3 — a succeeding owner mutation proves the clock was strictly pre-deadline.
          if (OWNER_MUTS.has(op) && ok) {
            expect(clock < deadline, `#3 owner-mutation '${op}' SUCCEEDED at/after deadline (clock=${clock} deadline=${deadline})`).to.equal(true);
          }
          // #7 — a hard-precondition-violating crank op must have reverted.
          if (mustFail && ok) {
            throw new Error(`#7 ORDERING VIOLATION: '${op}' SUCCEEDED with an unmet precondition ` +
              `(execLog=${execLogExists} executed=${executedBefore} solMaskFull=${solMaskFull} planMaskFull=${planMaskFull} ` +
              `tokExists=${tokExists} tokMaskFull=${tokMaskFull} openTok=${openTokBefore} clock=${clock} deadline=${deadline})`);
          }
          // #6 — explicit core-PDA close-safety (redundant with mustFail, kept for clarity).
          if (op === "closeOwner" && ok) {
            expect(executedBefore && openTokBefore === 0, `#6 closeOwner SUCCEEDED without executed && open_token_dists==0 (executed=${executedBefore} openTok=${openTokBefore})`).to.equal(true);
          }

          // #1 — executed is monotonic.
          expect(!prevExecuted || executedAfter, "#1 executed regressed from true to false").to.equal(true);
          prevExecuted = prevExecuted || executedAfter;

          if (vaultClosedNow) break; // core PDAs gone → stop (all further reads would fault)

          // #2 — masks are monotonic (bits only ever get set). A token_dist that is
          // closed is reset to 0 so a legitimate close+reopen starts a fresh cycle.
          {
            const solMaskAfter = !isClosed(svm, pdas.execution) ? readU32LE(svm, pdas.execution, OFF_EXEC_SOL_MASK) : prevSolMask;
            expect((solMaskAfter & prevSolMask) === prevSolMask, `#2 sol_paid_mask cleared a bit (${prevSolMask}→${solMaskAfter})`).to.equal(true);
            prevSolMask = solMaskAfter;
            // Re-check planCleared here (not the top-of-loop planLive): a clear_asset_plan
            // in THIS iteration just closed the account, so its mask is gone — skip it.
            if (hasPlan && !planCleared) {
              const pm = Number(readU64LE(svm, assetPlan, OFF_PLAN_MASK(asgCount)));
              expect((pm & prevPlanMask) === prevPlanMask, `#2 asset_plan.paid_mask cleared a bit (${prevPlanMask}→${pm})`).to.equal(true);
              prevPlanMask = pm;
            }
            if (token && td) {
              if (!isClosed(svm, td)) {
                const tm = readU32LE(svm, td, OFF_TOKENDIST_MASK);
                expect((tm & prevTokMask) === prevTokMask, `#2 token_dist.paid_mask cleared a bit (${prevTokMask}→${tm})`).to.equal(true);
                prevTokMask = tm;
              } else {
                prevTokMask = 0; // closed — a future begin_token_dist reopens with a fresh mask
              }
            }
          }

          // capture the write-once frozen snapshots the moment they exist.
          if (frozenS === null && !isClosed(svm, pdas.execution)) frozenS = readU64LE(svm, pdas.execution, OFF_EXEC_SOL_SNAPSHOT);
          if (frozenST === null && token && td && !isClosed(svm, td)) frozenST = readU64LE(svm, td, OFF_TOKENDIST_SNAPSHOT);

          // #5 — SOL conservation: the vault PDA never signs, so it only ever loses
          // to beneficiaries (paidToBenes) + the finalize bounty, and gains from
          // external deposits/withdraws — no fees, no created/destroyed lamports.
          {
            const paidToBenes = benes.reduce((a, b, i) => a + (bal(svm, b.publicKey) - benInit[i]), 0n);
            const expected = baseline + externalNet - paidToBenes - bountyPaid;
            expect(bal(svm, pdas.vault) === expected, `#5 SOL conservation broken: vault=${bal(svm, pdas.vault)} expected=${expected} (baseline=${baseline} extNet=${externalNet} paidToBenes=${paidToBenes} bounty=${bountyPaid})`).to.equal(true);
          }
          // #5 — token conservation: tokens only move within {benes, vaultAta, ownerAta}.
          if (token) {
            const sumTok = token.beneAtas.reduce((a, pk) => a + tokenBal(svm, pk), 0n) + tokenBal(svm, token.vaultAta) + tokenBal(svm, token.ownerAta);
            expect(sumTok === originalTokenBal, `#5 token conservation broken: Σ=${sumTok} original=${originalTokenBal}`).to.equal(true);
          }

          // #4 — no over-distribution. Once a snapshot is frozen, each beneficiary's
          // received amount is bounded by its pro-rata floor + its specific bequest.
          // The +nB slack absorbs the <n-unit close-dust (residual rounding swept to
          // the largest-share heir on close). The largest heir gets the SAME cap: a
          // close_token_dist can only run post-`executed`, and finalize requires the
          // full asset_plan.paid_mask, so every specific is already paid before any
          // close — the sweep is bounded rounding dust (<n), never an unpaid specific.
          if (frozenS !== null) {
            for (let i = 0; i < c.n; i++) {
              const delta = bal(svm, benes[i].publicKey) - benInit[i];
              const cap = (frozenS * BigInt(c.shares[i])) / 10000n + specSol[i] + nB;
              expect(delta <= cap, `#4 SOL over-distribution to benef[${i}]: delta=${delta} cap=${cap} (snapshot=${frozenS} share=${c.shares[i]})`).to.equal(true);
            }
          }
          if (token && frozenST !== null) {
            for (let i = 0; i < c.n; i++) {
              const delta = tokenBal(svm, token.beneAtas[i]);
              const cap = specTok[i] + (frozenST * BigInt(c.shares[i])) / 10000n + nB;
              expect(delta <= cap, `#4 token over-distribution to benef[${i}]: delta=${delta} cap=${cap} (snapshot=${frozenST} share=${c.shares[i]})`).to.equal(true);
            }
          }
        }
      })),
      // endOnFailure: skip shrinking — each run builds a heavy LiteSVM whose native
      // memory only frees on process exit, so a shrink storm would OOM. The raw
      // counterexample seed is still reported and reproducible. numRuns is LOW
      // because each run is a full 15–25-step sequence over one vault.
      { numRuns: 14, endOnFailure: true }
    );
  });
});
