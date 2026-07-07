// Permissionless executor crank. Once a vault's grace period elapses, anyone can
// drive distribution from on-chain state — this server does it keylessly, paying
// fees from CRANKER_KEYPAIR. The on-chain bitmasks are the source of truth, so the
// crank is a "do the next undone thing" loop that is safe to re-run every tick and
// to race against the app or beneficiaries (first writer wins, others no-op).
//
// It never closes the core PDAs (that is the owner-signed close, by design — B2).
import { readFileSync } from 'node:fs';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import { AnchorProvider, Program, Wallet, BN } from '@coral-xyz/anchor';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  getTransferFeeAmount,
  createHarvestWithheldTokensToMintInstruction,
} from '@solana/spl-token';
import { config } from './config.js';
import { CU, cuIxs, getPriorityFee } from './computeBudget.js';

const idl = JSON.parse(
  readFileSync(new URL('../idl/dead_mans_vault.json', import.meta.url), 'utf8'),
);

const PROGRAM_ID = new PublicKey(config.programId);
const BATCH = 8; // max payout indices per tx (CU + tx-size budget)
// Cap on non-plan token mints the server auto-distributes per vault. Bounds the
// cranker's rent spend if a vault is dusted with many junk mints (an attacker can
// send 1 unit of N mints; each TokenDist + beneficiary ATA is rent the cranker
// fronts). Owner-defined plan mints are always distributed; only surplus held
// mints beyond this cap are deferred to the (uncapped, user-paid) app/heir crank.
const MAX_AUTO_MINTS = 16;

let cached = null;

/** Lazily build the Anchor program + cranker, or null if executor not configured. */
function getCtx() {
  if (cached) return cached;
  if (!config.executorEnabled || !config.crankerKeypairPath) return null;
  let cranker;
  try {
    const secret = JSON.parse(readFileSync(config.crankerKeypairPath, 'utf8'));
    cranker = Keypair.fromSecretKey(Uint8Array.from(secret));
  } catch {
    return null;
  }
  const connection = new Connection(config.rpcUrl, 'confirmed');
  const provider = new AnchorProvider(connection, new Wallet(cranker), {
    commitment: 'confirmed',
  });
  const program = new Program(idl, provider);
  cached = { connection, provider, program, cranker, rpcUrl: config.rpcUrl };
  return cached;
}

export function executorReady() {
  return !!getCtx();
}

export function crankerPubkey() {
  const ctx = getCtx();
  return ctx ? ctx.cranker.publicKey.toBase58() : null;
}

// ── PDA helpers ──
const seedPda = (seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const executionPda = (vault) => seedPda([Buffer.from('execution'), vault.toBuffer()]);
const heartbeatPda = (vault) => seedPda([Buffer.from('heartbeat'), vault.toBuffer()]);
const assetPlanPda = (vault) => seedPda([Buffer.from('asset_plan'), vault.toBuffer()]);
const tokenDistPda = (vault, mint) =>
  seedPda([Buffer.from('token_dist'), vault.toBuffer(), mint.toBuffer()]);

// ── bit helpers ──
const bigMask = (m) => (typeof m === 'number' ? BigInt(m) : BigInt(m.toString()));
const bitSet = (mask, i) => ((bigMask(mask) >> BigInt(i)) & 1n) === 1n;
const fullMask = (n) => (1n << BigInt(n)) - 1n;
const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};
function largestShareIndex(beneficiaries) {
  let best = 0;
  let bestBps = -1;
  beneficiaries.forEach((b, i) => {
    if (b.shareBps > bestBps) {
      bestBps = b.shareBps;
      best = i;
    }
  });
  return best;
}

/**
 * Mints to distribute for a vault: held mints with a NON-ZERO balance ∪ plan
 * mints. Two important behaviours:
 *  - Zero-balance vault token accounts are skipped. On-chain begin_token_dist now
 *    rejects a mint the vault neither holds nor bequeaths (NothingToDistribute),
 *    so cranking such a mint would abort the whole run — and it was wasteful
 *    anyway. Plan mints are always kept (begin_token_dist allows a bequeathed but
 *    unheld mint, snapshotting 0).
 *  - Non-plan held mints beyond MAX_AUTO_MINTS (highest balance first) are
 *    deferred, bounding the cranker's rent spend against a dust-mint drain.
 */
/** Bounded retry for a mint-owner lookup (B2): a transient null/429 must not drop
 *  a plan mint from the map, which would skip its begin_token_dist for the tick. */
async function getAccountInfoRetry(connection, pubkey, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const acc = await connection.getAccountInfo(pubkey);
      if (acc) return acc;
    } catch { /* transient RPC error — retry */ }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 200 * (i + 1)));
  }
  return null;
}

async function collectMints(connection, vault, plan) {
  const info = new Map(); // mintBase58 -> { programId, amount: bigint, inPlan: bool }

  for (const pid of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const res = await connection.getParsedTokenAccountsByOwner(vault, { programId: pid });
    for (const { account } of res.value) {
      const p = account.data.parsed.info;
      const amount = BigInt(p.tokenAmount?.amount ?? '0');
      if (amount <= 0n) continue; // skip empty accounts (see NothingToDistribute above)
      const key = p.mint;
      const prev = info.get(key);
      info.set(key, {
        programId: pid,
        amount: (prev?.amount ?? 0n) + amount, // a mint may have several accounts
        inPlan: prev?.inPlan ?? false,
      });
    }
  }

  if (plan) {
    for (const a of plan.assignments) {
      if (a.mint.equals(PublicKey.default)) continue; // specific-SOL sentinel — no token dist
      const key = a.mint.toBase58();
      const prev = info.get(key);
      if (prev) {
        prev.inPlan = true;
        continue;
      }
      const acc = await getAccountInfoRetry(connection, a.mint);
      if (acc) info.set(key, { programId: acc.owner, amount: 0n, inPlan: true });
    }
  }

  const entries = [...info.entries()];
  const planMints = entries.filter(([, v]) => v.inPlan);
  const heldOnly = entries
    .filter(([, v]) => !v.inPlan)
    .sort((a, b) => (b[1].amount > a[1].amount ? 1 : b[1].amount < a[1].amount ? -1 : 0));

  const chosen = [...planMints];
  let deferred = 0;
  for (const e of heldOnly) {
    if (chosen.length >= MAX_AUTO_MINTS) {
      deferred++;
      continue;
    }
    chosen.push(e);
  }
  if (deferred > 0) {
    console.log(
      `[exec] ${vault.toBase58().slice(0, 8)}: token-mint cap ${MAX_AUTO_MINTS} hit; ` +
        `deferred ${deferred} low-balance mint(s) to the app/heir crank`,
    );
  }
  return chosen.map(([m, v]) => ({ mint: new PublicKey(m), programId: v.programId }));
}

/** Create a beneficiary ATA if missing (cranker pays the rent). */
async function ensureAta(ctx, ata, mint, owner, programId) {
  const info = await ctx.connection.getAccountInfo(ata);
  if (info) return;
  const ix = createAssociatedTokenAccountIdempotentInstruction(
    ctx.cranker.publicKey,
    ata,
    owner,
    mint,
    programId,
  );
  await ctx.provider.sendAndConfirm(
    new Transaction().add(...cuIxs(CU.ensureAta, ctx.priorityFee), ix),
  );
}

/**
 * Run the crank for one vault. Idempotent; returns an {action} describing the
 * furthest state reached this tick. Safe to call every poll tick.
 */
const inFlight = new Set(); // vaults currently being cranked (in-process lock)

export async function runExecutor(vaultStr) {
  const ctx = getCtx();
  if (!ctx) return { action: 'executor_disabled' };
  // In-process per-vault lock: /execute-now must not race a poll tick for the
  // same vault. On-chain masks keep funds safe, but the loser's txs revert with
  // MaskAlreadySet after paying fees. First caller wins; concurrent callers no-op.
  if (inFlight.has(vaultStr)) return { action: 'busy' };
  inFlight.add(vaultStr);
  try {
    return await runExecutorInner(ctx, vaultStr);
  } finally {
    inFlight.delete(vaultStr);
  }
}

async function runExecutorInner(ctx, vaultStr) {
  const { connection, program, cranker } = ctx;
  // Best-effort priority fee, fetched once per crank; every tx below prepends a
  // ComputeBudget CU-limit + price so it lands under mainnet congestion.
  ctx.priorityFee = await getPriorityFee(connection, ctx.rpcUrl);
  const vault = new PublicKey(vaultStr);
  const payer = cranker.publicKey;

  const cfg = await program.account.vaultConfig.fetchNullable(vault);
  if (!cfg) return { action: 'no_vault' };
  if (cfg.executed) return { action: 'already_executed' };

  const hb = await program.account.heartbeatRecord.fetch(heartbeatPda(vault));
  const deadline =
    hb.lastHeartbeat.toNumber() +
    cfg.heartbeatInterval.toNumber() +
    cfg.gracePeriod.toNumber();
  const now = Math.floor(Date.now() / 1000);
  if (now < deadline) return { action: 'not_due' };

  const beneficiaries = cfg.beneficiaries; // [{ wallet, shareBps }]
  const benCount = beneficiaries.length;
  const hasPlan = cfg.hasAssetPlan;
  const execPda = executionPda(vault);

  // A1 mitigation (mirrors keeper-bot/src/crank.js): a mint the issuer paused / froze /
  // hook-switched / made non-transferable makes its transfer_checked revert. Skip it
  // per-tick rather than aborting the whole crank — every OTHER asset still reaches the
  // heirs; only the stuck mint's residual + rent strand (the tolerable A1 outcome),
  // pending a program-level escape hatch (external-audit scope). On-chain masks keep
  // this idempotent — a transiently-failed mint retries next tick.
  const skipped = [];
  const stuckMints = new Set();
  const markStuck = (mint, step) => {
    stuckMints.add(mint.toBase58());
    skipped.push({ mint: mint.toBase58(), step });
  };
  const isStuck = (mint) => stuckMints.has(mint.toBase58());

  // 1. begin_execution (snapshot SOL residual). Existence proves grace downstream.
  let execLog = await program.account.executionLog.fetchNullable(execPda);
  if (!execLog) {
    await program.methods
      .beginExecution()
      .accountsPartial({
        payer,
        vaultConfig: vault,
        heartbeatRecord: heartbeatPda(vault),
        executionLog: execPda,
        // Pass the plan explicitly so specific-SOL is carved out of the residual;
        // must be null (not omitted) for no-plan vaults or Anchor auto-derives a
        // non-existent PDA.
        assetPlan: hasPlan ? assetPlanPda(vault) : null,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions(cuIxs(CU.beginExecution, ctx.priorityFee))
      .rpc();
    execLog = await program.account.executionLog.fetch(execPda);
  }

  let plan = hasPlan ? await program.account.assetPlan.fetch(assetPlanPda(vault)) : null;
  const mints = await collectMints(connection, vault, plan);

  // 2. begin_token_dist per mint (freeze each residual). No token_program arg.
  for (const { mint, programId } of mints) {
    const tdPda = tokenDistPda(vault, mint);
    const td = await program.account.tokenDist.fetchNullable(tdPda);
    if (td) continue;
    try {
      const vaultAta = getAssociatedTokenAddressSync(mint, vault, true, programId);
      // A bequest can name a mint the vault doesn't actually hold (no ATA). Create
      // the (empty) vault ATA first so begin_token_dist can snapshot it as 0 and the
      // specific bequest pays 0 — instead of throwing AccountNotInitialized and
      // stalling the whole distribution (which would freeze the owner out post-grace).
      await ensureAta(ctx, vaultAta, mint, vault, programId);
      await program.methods
        .beginTokenDist()
        .accountsPartial({
          payer,
          vaultConfig: vault,
          executionLog: execPda,
          mint,
          vaultAta,
          assetPlan: hasPlan ? assetPlanPda(vault) : null,
          tokenDist: tdPda,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions(cuIxs(CU.beginTokenDist, ctx.priorityFee))
        .rpc();
    } catch { markStuck(mint, 'begin_token_dist'); }
  }

  // 3. specific bequests, in ascending index order (the program enforces per-mint order).
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
        // Specific-SOL bequest (zero-pubkey sentinel) → dedicated lamport ix, no ATAs.
        if (isSol) {
          await program.methods
            .executeSpecificSol(j)
            .accountsPartial({
              payer,
              vaultConfig: vault,
              executionLog: execPda,
              assetPlan: assetPlanPda(vault),
              beneficiary: benWallet,
            })
            .preInstructions(cuIxs(CU.executeSpecificSol, ctx.priorityFee))
            .rpc();
          continue;
        }

        const mintInfo = mints.find((m) => m.mint.equals(a.mint));
        const programId = mintInfo ? mintInfo.programId : TOKEN_PROGRAM_ID;
        const vaultAta = getAssociatedTokenAddressSync(a.mint, vault, true, programId);
        const benAta = getAssociatedTokenAddressSync(a.mint, benWallet, false, programId);
        await ensureAta(ctx, benAta, a.mint, benWallet, programId);
        await program.methods
          .executeSpecificAsset(j)
          .accountsPartial({
            payer,
            vaultConfig: vault,
            executionLog: execPda,
            assetPlan: assetPlanPda(vault),
            mint: a.mint,
            tokenDist: tokenDistPda(vault, a.mint),
            vaultAta,
            beneficiaryAta: benAta,
            tokenProgram: programId,
          })
          .preInstructions(cuIxs(CU.executeSpecificAsset, ctx.priorityFee))
          .rpc();
      } catch {
        if (isSol) skipped.push({ mint: 'SOL', step: 'execute_specific_sol' });
        else markStuck(a.mint, 'execute_specific_asset');
      }
    }
  }

  // 4. SOL pro-rata shares, batched.
  execLog = await program.account.executionLog.fetch(execPda);
  const unpaidSol = beneficiaries
    .map((_, i) => i)
    .filter((i) => !bitSet(execLog.solPaidMask, i));
  for (const part of chunk(unpaidSol, BATCH)) {
    await program.methods
      .executeSolShares(Buffer.from(part))
      .accountsPartial({ payer, vaultConfig: vault, executionLog: execPda })
      .remainingAccounts(
        part.map((i) => ({ pubkey: beneficiaries[i].wallet, isWritable: true, isSigner: false })),
      )
      .preInstructions(cuIxs(CU.executeSolShares, ctx.priorityFee))
      .rpc();
  }

  // 5. finalize once SOL + specific masks are full. Re-fetch BOTH masks fresh —
  // if this same run just paid the last specific bequest, the in-memory `plan`
  // still holds the pre-payment mask, which would (wrongly) skip finalize and
  // then trip `close_token_dist` with VaultNotExecuted.
  execLog = await program.account.executionLog.fetch(execPda);
  if (hasPlan) plan = await program.account.assetPlan.fetch(assetPlanPda(vault));
  const solFull = bigMask(execLog.solPaidMask) === fullMask(benCount);
  const planFull = !hasPlan || bigMask(plan.paidMask) === fullMask(plan.assignments.length);
  if (!execLog.completed && solFull && planFull) {
    await program.methods
      .finalizeExecution()
      .accountsPartial({
        payer,
        vaultConfig: vault,
        executionLog: execPda,
        assetPlan: hasPlan ? assetPlanPda(vault) : null,
      })
      .preInstructions(cuIxs(CU.finalize, ctx.priorityFee))
      .rpc();
  }

  // 6. token residual pro-rata shares, batched (runs even post-finalize).
  for (const { mint, programId } of mints) {
    if (isStuck(mint)) continue;
    const tdPda = tokenDistPda(vault, mint);
    const td = await program.account.tokenDist.fetchNullable(tdPda);
    if (!td) continue;
    try {
      const vaultAta = getAssociatedTokenAddressSync(mint, vault, true, programId);
      const unpaid = beneficiaries.map((_, i) => i).filter((i) => !bitSet(td.paidMask, i));
      for (const part of chunk(unpaid, BATCH)) {
        const remaining = [];
        for (const i of part) {
          const benAta = getAssociatedTokenAddressSync(mint, beneficiaries[i].wallet, false, programId);
          await ensureAta(ctx, benAta, mint, beneficiaries[i].wallet, programId);
          remaining.push({ pubkey: benAta, isWritable: true, isSigner: false });
        }
        await program.methods
          .executeTokenShares(Buffer.from(part))
          .accountsPartial({ payer, vaultConfig: vault, tokenDist: tdPda, mint, vaultAta, tokenProgram: programId })
          .remainingAccounts(remaining)
          .preInstructions(cuIxs(CU.executeTokenShares, ctx.priorityFee))
          .rpc();
      }
    } catch { markStuck(mint, 'execute_token_shares'); }
  }

  // 7. close each TokenDist once its residual mask is full (dust → largest benef).
  //    close_token_dist requires vault.executed — if finalize didn't run this
  //    pass (a payout still pending), skip closing so a later pass finalizes
  //    first, instead of throwing VaultNotExecuted and aborting the whole run.
  const finalizedCfg = await program.account.vaultConfig.fetch(vault);
  for (const { mint, programId } of mints) {
    if (!finalizedCfg.executed) break;
    if (isStuck(mint)) continue;
    const tdPda = tokenDistPda(vault, mint);
    const td = await program.account.tokenDist.fetchNullable(tdPda);
    if (!td) continue;
    if (bigMask(td.paidMask) !== fullMask(benCount)) continue;
    try {
      const vaultAta = getAssociatedTokenAddressSync(mint, vault, true, programId);
      const maxIdx = largestShareIndex(beneficiaries);
      const maxWallet = beneficiaries[maxIdx].wallet;
      let dust = 0n, withheld = 0n;
      try {
        const acc = await getAccount(connection, vaultAta, 'confirmed', programId);
        dust = acc.amount;
        withheld = getTransferFeeAmount(acc)?.withheldAmount ?? 0n;
      } catch {
        dust = 0n;
      }
      let dustAta = null;
      if (dust > 0n) {
        dustAta = getAssociatedTokenAddressSync(mint, maxWallet, false, programId);
        await ensureAta(ctx, dustAta, mint, maxWallet, programId);
      }
      // Transfer-fee mints leave WITHHELD fees in the vault ATA (e.g. the deposit fee);
      // Token-2022 refuses to CloseAccount while fees are withheld, which sticks
      // close_token_dist and keeps open_token_dists > 0 (blocking the final close).
      // Harvest them to the mint first (permissionless), atomically before the close.
      const preIxs = withheld > 0n
        ? [createHarvestWithheldTokensToMintInstruction(mint, [vaultAta], programId)]
        : [];
      await program.methods
        .closeTokenDist()
        .accountsPartial({
          payer,
          owner: cfg.owner,
          vaultConfig: vault,
          mint,
          vaultAta,
          tokenDist: tdPda,
          largestBenefAta: dustAta,
          tokenProgram: programId,
        })
        .preInstructions([...cuIxs(CU.closeTokenDist, ctx.priorityFee), ...preIxs])
        .rpc();
    } catch { markStuck(mint, 'close_token_dist'); }
  }

  const finalCfg = await program.account.vaultConfig.fetch(vault);
  return {
    action: finalCfg.executed ? 'executed' : 'cranked',
    ...(skipped.length ? { skipped } : {}),
  };
}
