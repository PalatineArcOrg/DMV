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

const BATCH = 8; // payout indices per tx (CU + tx-size budget)
// Cap on non-plan token mints auto-distributed per vault — bounds the rent this
// keeper fronts if a vault is dusted with junk mints. Plan mints always run.
const MAX_AUTO_MINTS = 16;

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

/** Held mints (non-zero balance) ∪ plan mints, capped for non-plan dust. */
async function collectMints(connection, vault, plan) {
  const info = new Map();
  for (const pid of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const res = await connection.getParsedTokenAccountsByOwner(vault, { programId: pid });
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
      const acc = await getAccountInfoRetry(connection, a.mint);
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

async function ensureAta(ctx, ata, mint, owner, programId) {
  const info = await ctx.connection.getAccountInfo(ata);
  if (info) return;
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
export async function crankVault(ctx, vault, cfg) {
  const { connection, program, keeper } = ctx;
  // Best-effort priority fee, fetched once per crank; every tx below prepends a
  // ComputeBudget CU-limit + price so it lands under mainnet congestion.
  ctx.priorityFee = await getPriorityFee(connection, ctx.rpcUrl);
  const programId = program.programId;
  const payer = keeper.publicKey;
  const beneficiaries = cfg.beneficiaries;
  const benCount = beneficiaries.length;
  const hasPlan = cfg.hasAssetPlan;
  const execPda = executionPda(programId, vault);

  // 1. begin_execution — snapshot the SOL residual (existence proves grace).
  let execLog = await program.account.executionLog.fetchNullable(execPda);
  if (!execLog) {
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
    execLog = await program.account.executionLog.fetch(execPda);
  }

  let plan = hasPlan ? await program.account.assetPlan.fetch(assetPlanPda(programId, vault)) : null;
  const mints = await collectMints(connection, vault, plan);

  // 2. begin_token_dist per mint (freeze each residual). Create the vault ATA
  //    idempotently first — a bequest can name a mint the vault doesn't hold.
  for (const { mint, programId: tokenPid } of mints) {
    const tdPda = tokenDistPda(programId, vault, mint);
    if (await program.account.tokenDist.fetchNullable(tdPda)) continue;
    const vaultAta = getAssociatedTokenAddressSync(mint, vault, true, tokenPid);
    await ensureAta(ctx, vaultAta, mint, vault, tokenPid);
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
  }

  // 3. specific bequests, ascending per mint (program-enforced order).
  if (plan) {
    for (let j = 0; j < plan.assignments.length; j++) {
      if (bitSet(plan.paidMask, j)) continue;
      const a = plan.assignments[j];
      const benWallet = beneficiaries[a.beneficiaryIndex].wallet;
      if (a.mint.equals(PublicKey.default)) {
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
    }
  }

  // 4. SOL pro-rata shares, batched.
  execLog = await program.account.executionLog.fetch(execPda);
  const unpaidSol = beneficiaries.map((_, i) => i).filter((i) => !bitSet(execLog.solPaidMask, i));
  for (const part of chunk(unpaidSol, BATCH)) {
    await program.methods
      .executeSolShares(Buffer.from(part))
      .accountsPartial({ payer, vaultConfig: vault, executionLog: execPda })
      .remainingAccounts(part.map((i) => ({ pubkey: beneficiaries[i].wallet, isWritable: true, isSigner: false })))
      .preInstructions(cuIxs(CU.executeSolShares, ctx.priorityFee))
      .rpc();
  }

  // 5. finalize — pays the keeper bounty to this payer. Re-fetch BOTH masks
  //    fresh (paying the last bequest above leaves the in-memory copy stale).
  execLog = await program.account.executionLog.fetch(execPda);
  if (hasPlan) plan = await program.account.assetPlan.fetch(assetPlanPda(programId, vault));
  const solFull = bigMask(execLog.solPaidMask) === fullMask(benCount);
  const planFull = !hasPlan || bigMask(plan.paidMask) === fullMask(plan.assignments.length);
  if (!execLog.completed && solFull && planFull) {
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
    const tdPda = tokenDistPda(programId, vault, mint);
    const td = await program.account.tokenDist.fetchNullable(tdPda);
    if (!td) continue;
    const vaultAta = getAssociatedTokenAddressSync(mint, vault, true, tokenPid);
    const unpaid = beneficiaries.map((_, i) => i).filter((i) => !bitSet(td.paidMask, i));
    for (const part of chunk(unpaid, BATCH)) {
      const remaining = [];
      for (const i of part) {
        const benAta = getAssociatedTokenAddressSync(mint, beneficiaries[i].wallet, false, tokenPid);
        await ensureAta(ctx, benAta, mint, beneficiaries[i].wallet, tokenPid);
        remaining.push({ pubkey: benAta, isWritable: true, isSigner: false });
      }
      await program.methods
        .executeTokenShares(Buffer.from(part))
        .accountsPartial({ payer, vaultConfig: vault, tokenDist: tdPda, mint, vaultAta, tokenProgram: tokenPid })
        .remainingAccounts(remaining)
        .preInstructions(cuIxs(CU.executeTokenShares, ctx.priorityFee))
        .rpc();
    }
  }

  // 7. close each fully-paid TokenDist (dust → largest benef; ATA rent → owner,
  //    TokenDist rent → this keeper). Skip if finalize hasn't landed yet.
  const freshCfg = await program.account.vaultConfig.fetch(vault);
  if (freshCfg.executed) {
    for (const { mint, programId: tokenPid } of mints) {
      const tdPda = tokenDistPda(programId, vault, mint);
      const td = await program.account.tokenDist.fetchNullable(tdPda);
      if (!td) continue;
      if (bigMask(td.paidMask) !== fullMask(benCount)) continue;
      const vaultAta = getAssociatedTokenAddressSync(mint, vault, true, tokenPid);
      const maxWallet = beneficiaries[largestShareIndex(beneficiaries)].wallet;
      let dust = 0n, withheld = 0n;
      try {
        const acc = await getAccount(connection, vaultAta, 'confirmed', tokenPid);
        dust = acc.amount;
        withheld = getTransferFeeAmount(acc)?.withheldAmount ?? 0n;
      } catch { /* ATA missing */ }
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
      await program.methods
        .closeTokenDist()
        .accountsPartial({
          payer, owner: freshCfg.owner, vaultConfig: vault, mint, vaultAta,
          tokenDist: tdPda, largestBenefAta: dustAta, tokenProgram: tokenPid,
        })
        .preInstructions([...cuIxs(CU.closeTokenDist, ctx.priorityFee), ...preIxs])
        .rpc();
    }
  }

  return freshCfg.executed ? 'executed' : 'cranked';
}

/**
 * Cleanup for an already-executed vault: close any leftover fully-paid
 * TokenDists, then — once the 24h owner-exclusive window has passed — close the
 * core PDAs and collect their rents. The window check is left to the program
 * (CloseDelayNotElapsed): preflight simulation rejects an early attempt for
 * free, so no local clock/config is needed.
 */
export async function cleanupExecutedVault(ctx, vault, cfg) {
  const { program } = ctx;
  ctx.priorityFee = await getPriorityFee(ctx.connection, ctx.rpcUrl);
  const programId = program.programId;
  const execPda = executionPda(programId, vault);
  const execLog = await program.account.executionLog.fetchNullable(execPda);
  if (!execLog || !execLog.completed) return 'no_execution_log';

  // Finish any token dists a dead crank left behind (rare) — the main crank is
  // idempotent, so re-running it just performs the missing residual/close steps.
  if (cfg.openTokenDists > 0) {
    await crankVault(ctx, vault, cfg);
    const fresh = await program.account.vaultConfig.fetch(vault);
    if (fresh.openTokenDists > 0) return 'token_dists_open';
  }

  const maxWallet = cfg.beneficiaries[largestShareIndex(cfg.beneficiaries)].wallet;
  try {
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
