// The permissionless Dead Man's Vault crank, packaged for any keeper to run.
//
// Everything here submits the SAME program-enforced instructions the app and the
// notify-server use: the program computes every payout from frozen on-chain
// state, so a keeper controls nothing about destinations or amounts — it only
// pays fees and gets paid for finishing the job:
//   - `finalize_execution` pays the vault's keeper bounty to the finalizer, and
//   - after the 24h owner-exclusive window, `close_executed_vault` pays the
//     otherwise-stranded core-PDA rents (~0.01–0.03 SOL) to the closer.
//
// On-chain bitmasks make every step idempotent: this crank can race the app, the
// notify-server, other keepers — first writer wins, everyone else no-ops.
import {
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  getTransferFeeAmount,
  createHarvestWithheldTokensToMintInstruction,
} from '@solana/spl-token';
import { CU, cuIxs, getPriorityFee } from './computeBudget.js';
import { withTimeout } from './readiness.js';

// Per-attempt bound for a single account-info RPC read: a never-settling call must not wedge the retry
// loop (and thus the scheduler). Kept below the tick's SCAN_TIMEOUT_MS so several retries still fit.
const ACCT_INFO_TIMEOUT_MS = 8_000;

// Whole-pass deadline for cranking / cleaning up ONE vault. Every internal read below is bounded by the
// REMAINING budget (readWithin), so no single hung dependency can prevent the pass from returning; when
// the budget is exhausted the next read times out (TimeoutError) and the caller degrades the tick rather
// than grinding every remaining vault into the same wall. Submissions are NOT force-abandoned (a bare
// Promise.race would let an abandoned .rpc() keep submitting) — the bounded reads gate forward progress.
export const VAULT_PASS_DEADLINE_MS = 25_000;

/** Bound an internal read by the vault-pass deadline: withTimeout(promise, remaining) where
 *  remaining = ctx.deadline - now (min 1ms). A TimeoutError here means the pass budget is spent. */
function readWithin(ctx, promise, label) {
  const remaining = ctx?.deadline ? Math.max(1, ctx.deadline - Date.now()) : ACCT_INFO_TIMEOUT_MS;
  return withTimeout(promise, remaining, label);
}

const BATCH = 8; // payout indices per tx (CU + tx-size budget)
// Cap on non-plan token mints auto-distributed per vault — bounds the rent this
// keeper fronts if a vault is dusted with junk mints. Plan mints always run.
const MAX_AUTO_MINTS = 16;

// Live readiness guard for an in-flight keeper crank (Phase 2). A crank submits MANY transactions
// across many RPCs; unlike the notify-server the keeper has no background monitor, so the guard is an
// ASYNC pre-submit check that REVALIDATES the network immediately before every transaction (including
// ATA creation). `canSubmit` is an async function that returns false once the network is no longer
// positively VERIFIED — so an RPC endpoint that switches clusters DURING a long multi-tx crank is
// detected before the next submission, not just between vaults. canSubmit is MANDATORY and the guard
// is fail-closed: a missing or false-returning canSubmit both halt (an unguarded crank can't submit).
export const KEEPER_HALT = '__KEEPER_READINESS_REVOKED__';
export function makeKeeperGuard(canSubmit) {
  return async () => {
    // Fail-closed: a missing function, a false return, a throw, OR a rejection ALL convert to
    // KEEPER_HALT. A throwing/rejecting canSubmit must not escape as an arbitrary error — a token
    // catch downstream could then misclassify it as operational (skip/stuck) instead of aborting.
    let ok;
    try { ok = typeof canSubmit === 'function' && (await canSubmit()); }
    catch { throw new Error(KEEPER_HALT); }
    if (!ok) throw new Error(KEEPER_HALT);
  };
}

// Fail-closed fault classification (Blocker 5). The per-vault crank loop must CONTINUE only for
// EXPECTED operational failures (an Anchor/web3 transaction that reverts or fails to land, or an RPC
// blip) — skipping that one vault and moving on. An UNKNOWN fault (a programming error, an invariant
// violation, malformed decoded state) must NOT be swallowed as "this vault is stuck": it escapes to
// the process fatal guard so the scheduler stops and systemd restarts from clean state.
export function isOperationalCrankError(e) {
  const m = (e?.message || '').toLowerCase();
  const code = String(e?.cause?.code ?? e?.code ?? '').toLowerCase();
  // A `withTimeout`-produced TimeoutError (bounded scan / heartbeat / account-info / ATA lookup) is
  // ALWAYS a transient operational timeout — recognise it by its explicit name (unambiguous, unlike the
  // bare word "timeout" which a coder fault could contain), so a bounded RPC hang degrades/retries.
  if (e?.name === 'TimeoutError') return true;
  // Step 1 — TIGHTLY-CONSTRAINED transport recognition BEFORE the type check. Node surfaces an
  // unreachable RPC as a `TypeError('fetch failed')` whose message is EXACTLY `fetch failed`, usually
  // with a transport cause.code. Recognise ONLY that exact message (not a substring — so an ordinary
  // `Error('unexpected fetch failed validation state')` is NOT reclassified as operational) OR an
  // explicit transport error code — never a generic word like network/socket/timeout, which can appear
  // in a programming fault's message or property name. So an outage degrades while a coder fault reaches
  // the fatal guard.
  if (m.trim() === 'fetch failed') return true;
  if (/^(econnrefused|econnreset|enotfound|eai_again|etimedout|epipe|und_err)/.test(code)) return true;
  // Step 2 — native programming-error TYPES are NEVER operational — fail closed (rethrow).
  if (e instanceof TypeError || e instanceof ReferenceError || e instanceof RangeError || e instanceof SyntaxError) {
    return false;
  }
  // Step 3 — operational MESSAGE matching for ordinary Error objects only. Prefer recognised error
  // CLASSES + program logs, then SPECIFIC web3/Anchor/RPC message shapes. Deliberately NOT the bare
  // generic words `transaction`/`instruction`/`network`/`socket`/`timeout`/`dns`/`rpc`/`signature`/
  // `insufficient`/`blockhash`/`simulat`: those false-positive on a coder fault (e.g. `Error('blockhash
  // cache invariant violated')`, `Error('simulation decoder invariant violated')`) and would mask it as
  // a skippable RPC blip. Only concrete transport/RPC/library shapes are kept (`blockhash not found`,
  // `transaction simulation failed`, `insufficient funds`, `signature verification`, `block height
  // exceeded`, `network error`, explicit transport codes, …).
  const name = e?.name || '';
  if (name === 'SendTransactionError' || name === 'AnchorError' || name === 'ProgramError') return true;
  if (Array.isArray(e?.logs)) return true; // web3.js tx simulate/send failure carries program logs
  return /blockhash not found|transaction simulation failed|simulation failed|preflight|custom program error|timed out|request timed out|timeout of|429|too many requests|rate limit|econnrefused|econnreset|enotfound|eai_again|getaddrinfo|etimedout|epipe|und_err|network error|socket hang up|node is behind|insufficient funds|insufficient lamports|closedelaynotelapsed|already been processed|not been confirmed|not confirmed in|block height exceeded|signature verification|account (does not|not) exist|accountnotinitialized/.test(m);
}

/** Per-vault error decision: 'halt' (readiness revoked → stop the tick), 'skip' (expected operational
 *  failure → skip this vault, continue), 'fatal' (unknown fault → rethrow to the process fatal guard). */
export function classifyVaultError(e) {
  if (e?.message === KEEPER_HALT) return 'halt';
  if (e?.name === 'TimeoutError') return 'skip'; // a BOUNDED per-vault RPC timeout (withTimeout) → skip this vault, retry next tick
  return isOperationalCrankError(e) ? 'skip' : 'fatal';
}

/** Scan-phase failure decision for tick(): a bounded scan RPC that HUNG (withTimeout → `TimeoutError`)
 *  is transient (skip this tick, retry next) exactly like any recognised operational RPC failure; only a
 *  programming/coder fault is non-transient and must escape to the process fatal guard. Kept next to the
 *  classifier (not inline in the self-executing index.js) so it is unit-testable. */
export function isTransientScanError(e) {
  return e?.name === 'TimeoutError' || isOperationalCrankError(e);
}

// ── PDA helpers ──
const seedPda = (programId, seeds) => PublicKey.findProgramAddressSync(seeds, programId)[0];
export const heartbeatPda = (programId, vault) =>
  seedPda(programId, [Buffer.from('heartbeat'), vault.toBuffer()]);
const executionPda = (programId, vault) =>
  seedPda(programId, [Buffer.from('execution'), vault.toBuffer()]);
const assetPlanPda = (programId, vault) =>
  seedPda(programId, [Buffer.from('asset_plan'), vault.toBuffer()]);
const tokenDistPda = (programId, vault, mint) =>
  seedPda(programId, [Buffer.from('token_dist'), vault.toBuffer(), mint.toBuffer()]);

// ── bit helpers ──
const bigMask = (m) => (typeof m === 'number' ? BigInt(m) : BigInt(m.toString()));
const bitSet = (mask, i) => ((bigMask(mask) >> BigInt(i)) & 1n) === 1n;
const fullMask = (n) => (1n << BigInt(n)) - 1n;
const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};
const largestShareIndex = (beneficiaries) => {
  let best = 0, bestBps = -1;
  beneficiaries.forEach((b, i) => {
    if (b.shareBps > bestBps) { bestBps = b.shareBps; best = i; }
  });
  return best;
};

/** Bounded retry for a mint-owner lookup (B2): a transient null/429 must not drop
 *  a plan mint from the map, which would skip its begin_token_dist for the tick.
 *  Exported for focused escape/retry tests. */
export async function getAccountInfoRetry(connection, pubkey, tries = 4, timeoutMs = ACCT_INFO_TIMEOUT_MS) {
  for (let i = 0; i < tries; i++) {
    try {
      // BOUND each attempt: an unbounded getAccountInfo that never settles would hang the retry loop
      // forever (neither retry nor backoff runs) and wedge the scheduler. withTimeout → TimeoutError.
      const acc = await withTimeout(connection.getAccountInfo(pubkey), timeoutMs, 'account-info');
      if (acc) return acc;
    } catch (e) {
      // A per-attempt TIMEOUT or a recognized OPERATIONAL RPC failure is retryable. A native programming
      // fault (TypeError/etc.) or other unknown error must ESCAPE to the fatal guard, not be silently
      // retried away and dropped as a null (which would then omit a plan mint from the tick).
      if (e?.name !== 'TimeoutError' && !isOperationalCrankError(e)) throw e;
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 200 * (i + 1)));
  }
  return null;
}

/** Held mints (non-zero balance) ∪ plan mints, capped for non-plan dust. */
async function collectMints(ctx, vault, plan) {
  const connection = ctx.connection;
  const info = new Map();
  for (const pid of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const res = await readWithin(ctx, connection.getParsedTokenAccountsByOwner(vault, { programId: pid }), 'token-accounts');
    for (const { account } of res.value) {
      const p = account.data.parsed.info;
      const amount = BigInt(p.tokenAmount?.amount ?? '0');
      if (amount <= 0n) continue; // begin_token_dist rejects unheld+unbequeathed mints
      const prev = info.get(p.mint);
      info.set(p.mint, {
        programId: pid,
        amount: (prev?.amount ?? 0n) + amount,
        inPlan: prev?.inPlan ?? false,
      });
    }
  }
  if (plan) {
    for (const a of plan.assignments) {
      if (a.mint.equals(PublicKey.default)) continue; // specific-SOL sentinel
      const key = a.mint.toBase58();
      const prev = info.get(key);
      if (prev) { prev.inPlan = true; continue; }
      const acc = await readWithin(ctx, getAccountInfoRetry(connection, a.mint), 'mint-owner');
      if (acc) info.set(key, { programId: acc.owner, amount: 0n, inPlan: true });
    }
  }
  const entries = [...info.entries()];
  const planMints = entries.filter(([, v]) => v.inPlan);
  const heldOnly = entries
    .filter(([, v]) => !v.inPlan)
    .sort((a, b) => (b[1].amount > a[1].amount ? 1 : b[1].amount < a[1].amount ? -1 : 0));
  const chosen = [...planMints, ...heldOnly.slice(0, Math.max(0, MAX_AUTO_MINTS - planMints.length))];
  return chosen.map(([m, v]) => ({ mint: new PublicKey(m), programId: v.programId }));
}

// Read-only: does the vault PDA still own any token account with a positive balance?
// Uncapped across both token programs — unlike collectMints (which caps non-plan
// mints at MAX_AUTO_MINTS to bound fronted rent), this scan is exhaustive because it
// gates the irreversible core-PDA close. A fully-distributed mint leaves no vault
// token account behind (close_token_dist CloseAccounts the vault ATA), so a surviving
// positive balance is genuinely undistributed value a permissionless close would
// orphan forever. Deliberately read-only: we never begin_token_dist a straggler here
// — doing so on a frozen/paused mint would ratchet open_token_dists up with no way
// back down, permanently blocking every core close (the owner's included).
async function vaultHoldsUndistributedTokens(ctx, vault) {
  for (const pid of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const res = await readWithin(ctx, ctx.connection.getParsedTokenAccountsByOwner(vault, { programId: pid }), 'token-accounts');
    for (const { account } of res.value) {
      if (BigInt(account.data.parsed.info.tokenAmount?.amount ?? '0') > 0n) return true;
    }
  }
  return false;
}

async function ensureAta(ctx, ata, mint, owner, programId) {
  // BOUND the existence lookup: a never-settling getAccountInfo before the readiness guard would wedge
  // the crank permanently. On a TimeoutError the caller's catch classifies it operational → the mint is
  // marked stuck and safely retried on a later tick (nothing is submitted from an unverified lookup).
  const info = await withTimeout(ctx.connection.getAccountInfo(ata), ACCT_INFO_TIMEOUT_MS, 'ata-lookup');
  if (info) return;
  if (ctx.guard) await ctx.guard(); // async readiness revalidation immediately before the ATA-creation submission
  const ix = createAssociatedTokenAccountIdempotentInstruction(
    ctx.keeper.publicKey, ata, owner, mint, programId,
  );
  await ctx.provider.sendAndConfirm(
    new Transaction().add(...cuIxs(CU.ensureAta, ctx.priorityFee), ix),
  );
}

/**
 * Crank one expired vault through the full distribution (§7 sequence). Idempotent
 * and resumable — a partial run by anyone else is picked up where it stopped.
 */
export async function crankVault(ctx, vault, cfg, { canSubmit } = {}) {
  const { connection, program, keeper } = ctx;
  // Mandatory live readiness guard — checked immediately before EVERY submission below (and inside
  // ensureAta via ctx.guard). A missing canSubmit is a wiring bug and must fail loudly, not crank
  // unguarded.
  if (typeof canSubmit !== 'function') {
    throw new Error('crankVault requires a canSubmit readiness guard (fail-closed)');
  }
  const guard = makeKeeperGuard(canSubmit);
  ctx.guard = guard;
  // Whole-pass deadline: every internal read below is bounded by the remaining budget (readWithin), so a
  // single hung dependency can't prevent this pass from returning. Set before the first read.
  ctx.deadline = Date.now() + (ctx.passDeadlineMs ?? VAULT_PASS_DEADLINE_MS);
  // Best-effort priority fee, fetched once per crank; every tx below prepends a
  // ComputeBudget CU-limit + price so it lands under mainnet congestion.
  ctx.priorityFee = await readWithin(ctx, getPriorityFee(connection, ctx.rpcUrl), 'priority-fee');
  const programId = program.programId;
  const payer = keeper.publicKey;
  const beneficiaries = cfg.beneficiaries;
  const benCount = beneficiaries.length;
  const hasPlan = cfg.hasAssetPlan;
  const execPda = executionPda(programId, vault);

  // A1 mitigation: a mint the issuer has paused / frozen / hook-switched / made
  // non-transferable makes its transfer_checked revert. Previously that threw out of
  // the whole crank and stalled the distribution of every OTHER asset (and re-hit the
  // same wall every tick). Instead, skip a stuck mint per-tick: all distributable
  // assets still reach the heirs; only the stuck mint's residual + rent strand (the
  // tolerable A1 outcome), pending a program-level escape hatch (external-audit scope).
  // On-chain masks keep this idempotent — a transiently-failed mint retries next tick.
  const skipped = [];
  const stuckMints = new Set();
  const markStuck = (mint, step) => {
    stuckMints.add(mint.toBase58());
    skipped.push({ mint: mint.toBase58(), step });
  };
  const isStuck = (mint) => stuckMints.has(mint.toBase58());

  // 1. begin_execution — snapshot the SOL residual (existence proves grace).
  let execLog = await readWithin(ctx, program.account.executionLog.fetchNullable(execPda), 'executionLog');
  if (!execLog) {
    await guard();
    await program.methods
      .beginExecution()
      .accountsPartial({
        payer,
        vaultConfig: vault,
        heartbeatRecord: heartbeatPda(programId, vault),
        executionLog: execPda,
        // Must be null (not omitted) for no-plan vaults, or Anchor auto-derives
        // a non-existent PDA and the ix fails AccountNotInitialized.
        assetPlan: hasPlan ? assetPlanPda(programId, vault) : null,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions(cuIxs(CU.beginExecution, ctx.priorityFee))
      .rpc();
    execLog = await readWithin(ctx, program.account.executionLog.fetch(execPda), 'executionLog');
  }

  let plan = hasPlan ? await readWithin(ctx, program.account.assetPlan.fetch(assetPlanPda(programId, vault)), 'assetPlan') : null;
  const mints = await collectMints(ctx, vault, plan);

  // 2. begin_token_dist per mint (freeze each residual). Create the vault ATA
  //    idempotently first — a bequest can name a mint the vault doesn't hold.
  for (const { mint, programId: tokenPid } of mints) {
    const tdPda = tokenDistPda(programId, vault, mint);
    if (await readWithin(ctx, program.account.tokenDist.fetchNullable(tdPda), 'tokenDist')) continue;
    try {
      const vaultAta = getAssociatedTokenAddressSync(mint, vault, true, tokenPid);
      await ensureAta(ctx, vaultAta, mint, vault, tokenPid);
      await guard();
      await program.methods
        .beginTokenDist()
        .accountsPartial({
          payer,
          vaultConfig: vault,
          executionLog: execPda,
          mint,
          vaultAta,
          assetPlan: hasPlan ? assetPlanPda(programId, vault) : null,
          tokenDist: tdPda,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions(cuIxs(CU.beginTokenDist, ctx.priorityFee))
        .rpc();
    } catch (e) {
      if (e?.message === KEEPER_HALT) throw e; // a revocation must abort, never be reclassified as stuck
      if (!isOperationalCrankError(e)) throw e; // programming/unknown fault → escape to the fatal guard, never "stuck"
      markStuck(mint, 'begin_token_dist');
    }
  }

  // 3. specific bequests, ascending per mint (program-enforced order).
  if (plan) {
    for (let j = 0; j < plan.assignments.length; j++) {
      if (bitSet(plan.paidMask, j)) continue;
      const a = plan.assignments[j];
      const isSol = a.mint.equals(PublicKey.default);
      // A stuck mint's earlier bequest already failed → its later ones would revert
      // SpecificOutOfOrder anyway; skip them so the loop reaches other mints' bequests.
      if (!isSol && isStuck(a.mint)) continue;
      const benWallet = beneficiaries[a.beneficiaryIndex].wallet;
      try {
        if (isSol) {
          await guard();
          await program.methods
            .executeSpecificSol(j)
            .accountsPartial({
              payer, vaultConfig: vault, executionLog: execPda,
              assetPlan: assetPlanPda(programId, vault), beneficiary: benWallet,
            })
            .preInstructions(cuIxs(CU.executeSpecificSol, ctx.priorityFee))
            .rpc();
          continue;
        }
        const mintInfo = mints.find((m) => m.mint.equals(a.mint));
        const tokenPid = mintInfo ? mintInfo.programId : TOKEN_PROGRAM_ID;
        const vaultAta = getAssociatedTokenAddressSync(a.mint, vault, true, tokenPid);
        const benAta = getAssociatedTokenAddressSync(a.mint, benWallet, false, tokenPid);
        await ensureAta(ctx, benAta, a.mint, benWallet, tokenPid);
        await guard();
        await program.methods
          .executeSpecificAsset(j)
          .accountsPartial({
            payer, vaultConfig: vault, executionLog: execPda,
            assetPlan: assetPlanPda(programId, vault),
            mint: a.mint, tokenDist: tokenDistPda(programId, vault, a.mint),
            vaultAta, beneficiaryAta: benAta, tokenProgram: tokenPid,
          })
          .preInstructions(cuIxs(CU.executeSpecificAsset, ctx.priorityFee))
          .rpc();
      } catch (e) {
        if (e?.message === KEEPER_HALT) throw e; // abort the crank; do not reclassify as stuck
        if (!isOperationalCrankError(e)) throw e; // programming/unknown fault → escape to the fatal guard, never "stuck"
        if (isSol) skipped.push({ mint: 'SOL', step: 'execute_specific_sol' });
        else markStuck(a.mint, 'execute_specific_asset');
      }
    }
  }

  // 4. SOL pro-rata shares, batched.
  execLog = await readWithin(ctx, program.account.executionLog.fetch(execPda), 'executionLog');
  const unpaidSol = beneficiaries.map((_, i) => i).filter((i) => !bitSet(execLog.solPaidMask, i));
  for (const part of chunk(unpaidSol, BATCH)) {
    await guard();
    await program.methods
      .executeSolShares(Buffer.from(part))
      .accountsPartial({ payer, vaultConfig: vault, executionLog: execPda })
      .remainingAccounts(part.map((i) => ({ pubkey: beneficiaries[i].wallet, isWritable: true, isSigner: false })))
      .preInstructions(cuIxs(CU.executeSolShares, ctx.priorityFee))
      .rpc();
  }

  // 5. finalize — pays the keeper bounty to this payer. Re-fetch BOTH masks
  //    fresh (paying the last bequest above leaves the in-memory copy stale).
  execLog = await readWithin(ctx, program.account.executionLog.fetch(execPda), 'executionLog');
  if (hasPlan) plan = await readWithin(ctx, program.account.assetPlan.fetch(assetPlanPda(programId, vault)), 'assetPlan');
  const solFull = bigMask(execLog.solPaidMask) === fullMask(benCount);
  const planFull = !hasPlan || bigMask(plan.paidMask) === fullMask(plan.assignments.length);
  // Do NOT finalize while a mint is stuck. A begin_token_dist that failed (marked stuck) never opened
  // its TokenDist, so open_token_dists stays 0 — and executed-vault cleanup only re-cranks when
  // open_token_dists > 0. Finalizing here would mark the vault executed and STRAND that mint's residual
  // (cleanup can't detect it). Blocking finalize keeps the vault non-executed so the NEXT tick re-cranks
  // it (re-attempting begin_token_dist for the stuck mint).
  if (!execLog.completed && solFull && planFull && stuckMints.size === 0) {
    await guard();
    await program.methods
      .finalizeExecution()
      .accountsPartial({
        payer, vaultConfig: vault, executionLog: execPda,
        assetPlan: hasPlan ? assetPlanPda(programId, vault) : null,
      })
      .preInstructions(cuIxs(CU.finalize, ctx.priorityFee))
      .rpc();
  }

  // 6. token residual pro-rata, batched (may run post-finalize).
  for (const { mint, programId: tokenPid } of mints) {
    if (isStuck(mint)) continue;
    const tdPda = tokenDistPda(programId, vault, mint);
    const td = await readWithin(ctx, program.account.tokenDist.fetchNullable(tdPda), 'tokenDist');
    if (!td) continue;
    try {
      const vaultAta = getAssociatedTokenAddressSync(mint, vault, true, tokenPid);
      const unpaid = beneficiaries.map((_, i) => i).filter((i) => !bitSet(td.paidMask, i));
      for (const part of chunk(unpaid, BATCH)) {
        const remaining = [];
        for (const i of part) {
          const benAta = getAssociatedTokenAddressSync(mint, beneficiaries[i].wallet, false, tokenPid);
          await ensureAta(ctx, benAta, mint, beneficiaries[i].wallet, tokenPid);
          remaining.push({ pubkey: benAta, isWritable: true, isSigner: false });
        }
        await guard();
        await program.methods
          .executeTokenShares(Buffer.from(part))
          .accountsPartial({ payer, vaultConfig: vault, tokenDist: tdPda, mint, vaultAta, tokenProgram: tokenPid })
          .remainingAccounts(remaining)
          .preInstructions(cuIxs(CU.executeTokenShares, ctx.priorityFee))
          .rpc();
      }
    } catch (e) {
      if (e?.message === KEEPER_HALT) throw e;
      if (!isOperationalCrankError(e)) throw e; // programming/unknown fault → escape to the fatal guard, never "stuck"
      markStuck(mint, 'execute_token_shares');
    }
  }

  // 7. close each fully-paid TokenDist (dust → largest benef; ATA rent → owner,
  //    TokenDist rent → this keeper). Skip if finalize hasn't landed yet.
  const freshCfg = await readWithin(ctx, program.account.vaultConfig.fetch(vault), 'vaultConfig');
  if (freshCfg.executed) {
    for (const { mint, programId: tokenPid } of mints) {
      if (isStuck(mint)) continue;
      const tdPda = tokenDistPda(programId, vault, mint);
      const td = await readWithin(ctx, program.account.tokenDist.fetchNullable(tdPda), 'tokenDist');
      if (!td) continue;
      if (bigMask(td.paidMask) !== fullMask(benCount)) continue;
      try {
        const vaultAta = getAssociatedTokenAddressSync(mint, vault, true, tokenPid);
        const maxWallet = beneficiaries[largestShareIndex(beneficiaries)].wallet;
        let dust = 0n, withheld = 0n;
        try {
          // Bounded like every other pass read — the only internal read that had slipped the deadline.
          const acc = await readWithin(ctx, getAccount(connection, vaultAta, 'confirmed', tokenPid), 'vault-ata');
          dust = acc.amount;
          withheld = getTransferFeeAmount(acc)?.withheldAmount ?? 0n;
        } catch (e) {
          // A genuinely-absent vault ATA (already swept + closed) is the ONLY case that
          // legitimately means "no dust" — getAccount signals it with these two named
          // errors. Everything else must NOT be silently read as 0: a programming fault
          // escapes to the fatal guard; an RPC blip falls through best-effort (dust stays
          // 0n and the close still attempts, staying idempotent).
          const missing = e?.name === 'TokenAccountNotFoundError' || e?.name === 'TokenInvalidAccountOwnerError';
          if (!missing && !isOperationalCrankError(e)) throw e;
        }
        let dustAta = null;
        if (dust > 0n) {
          dustAta = getAssociatedTokenAddressSync(mint, maxWallet, false, tokenPid);
          await ensureAta(ctx, dustAta, mint, maxWallet, tokenPid);
        }
        // Transfer-fee mints leave WITHHELD fees in the vault ATA (e.g. the deposit fee);
        // Token-2022 refuses to CloseAccount while fees are withheld, which sticks
        // close_token_dist and keeps open_token_dists > 0 (blocking the final close).
        // Harvest them to the mint first (permissionless), atomically before the close.
        const preIxs = withheld > 0n
          ? [createHarvestWithheldTokensToMintInstruction(mint, [vaultAta], tokenPid)]
          : [];
        await guard();
        await program.methods
          .closeTokenDist()
          .accountsPartial({
            payer, owner: freshCfg.owner, vaultConfig: vault, mint, vaultAta,
            tokenDist: tdPda, largestBenefAta: dustAta, tokenProgram: tokenPid,
          })
          .preInstructions([...cuIxs(CU.closeTokenDist, ctx.priorityFee), ...preIxs])
          .rpc();
      } catch (e) {
        if (e?.message === KEEPER_HALT) throw e;
        if (!isOperationalCrankError(e)) throw e; // programming/unknown fault → escape to the fatal guard, never "stuck"
        markStuck(mint, 'close_token_dist');
      }
    }
  }

  const base = freshCfg.executed ? 'executed' : 'cranked';
  return skipped.length
    ? `${base} (skipped ${skipped.length}: ${[...new Set(skipped.map((s) => s.mint.slice(0, 8)))].join(',')})`
    : base;
}

/**
 * Cleanup for an already-executed vault: close any leftover fully-paid
 * TokenDists, then — once the 24h owner-exclusive window has passed — close the
 * core PDAs and collect their rents. The window check is left to the program
 * (CloseDelayNotElapsed): preflight simulation rejects an early attempt for
 * free, so no local clock/config is needed.
 */
export async function cleanupExecutedVault(ctx, vault, cfg, { canSubmit } = {}) {
  const { program } = ctx;
  // Same mandatory live guard as crankVault — the close_executed_vault submission (and any recursive
  // crank below) must be suppressed if readiness is revoked.
  if (typeof canSubmit !== 'function') {
    throw new Error('cleanupExecutedVault requires a canSubmit readiness guard (fail-closed)');
  }
  const guard = makeKeeperGuard(canSubmit);
  ctx.guard = guard;
  // Whole-pass deadline for this cleanup pass (same contract as crankVault) — bound every internal read.
  ctx.deadline = Date.now() + (ctx.passDeadlineMs ?? VAULT_PASS_DEADLINE_MS);
  ctx.priorityFee = await readWithin(ctx, getPriorityFee(ctx.connection, ctx.rpcUrl), 'priority-fee');
  const programId = program.programId;
  const execPda = executionPda(programId, vault);
  const execLog = await readWithin(ctx, program.account.executionLog.fetchNullable(execPda), 'executionLog');
  if (!execLog || !execLog.completed) return 'no_execution_log';

  // Finish any token dists a dead crank left behind (rare) — the main crank is
  // idempotent, so re-running it just performs the missing residual/close steps.
  if (cfg.openTokenDists > 0) {
    await crankVault(ctx, vault, cfg, { canSubmit });
    const fresh = await readWithin(ctx, program.account.vaultConfig.fetch(vault), 'vaultConfig');
    if (fresh.openTokenDists > 0) return 'token_dists_open';
  }

  // Anti-orphan gate: close_executed_vault only checks open_token_dists, which a
  // never-begun held mint never increments — so a vault holding more than
  // MAX_AUTO_MINTS non-plan mints can reach 0 here with real balances left, and the
  // close would orphan them forever (the vault PDA can never sign again). Refuse to
  // close while the vault still owns any token balance: the core rent stays
  // reclaimable and the tokens stay inheritable via a later uncapped app/heir crank.
  // Best-effort (scan->close is a TOCTOU, and the owner-signed close doesn't re-scan);
  // the durable guarantee is the on-chain A1 escape-hatch work (external-audit scope).
  if (await vaultHoldsUndistributedTokens(ctx, vault)) {
    return 'held_mints_remain';
  }

  const maxWallet = cfg.beneficiaries[largestShareIndex(cfg.beneficiaries)].wallet;
  try {
    await guard();
    await program.methods
      .closeExecutedVault()
      .accountsPartial({
        payer: ctx.keeper.publicKey,
        vaultConfig: vault,
        heartbeatRecord: heartbeatPda(programId, vault),
        executionLog: execPda,
        assetPlan: cfg.hasAssetPlan ? assetPlanPda(programId, vault) : null,
        largestBenef: maxWallet, // required only when dust remains; passing it is always safe
      })
      .preInstructions(cuIxs(CU.closeExecutedVault, ctx.priorityFee))
      .rpc();
    return 'closed';
  } catch (e) {
    const msg = e?.toString?.() ?? '';
    if (msg.includes('CloseDelayNotElapsed')) return 'window_open';
    throw e;
  }
}
