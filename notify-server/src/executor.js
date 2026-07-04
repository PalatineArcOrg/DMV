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
} from '@solana/spl-token';
import { config } from './config.js';

const idl = JSON.parse(
  readFileSync(new URL('../idl/dead_mans_vault.json', import.meta.url), 'utf8'),
);

const PROGRAM_ID = new PublicKey(config.programId);
const BATCH = 8; // max payout indices per tx (CU + tx-size budget)

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
  cached = { connection, provider, program, cranker };
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

/** All mints the vault holds (across both token programs) ∪ assignment mints. */
async function collectMints(connection, vault, plan) {
  const found = new Map(); // mintBase58 -> PublicKey programId
  for (const pid of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const res = await connection.getParsedTokenAccountsByOwner(vault, { programId: pid });
    for (const { account } of res.value) {
      found.set(account.data.parsed.info.mint, pid);
    }
  }
  if (plan) {
    for (const a of plan.assignments) {
      // Specific-SOL bequests use the zero-pubkey sentinel — they have no token dist.
      if (a.mint.equals(PublicKey.default)) continue;
      const key = a.mint.toBase58();
      if (!found.has(key)) {
        const info = await connection.getAccountInfo(a.mint);
        if (info) found.set(key, info.owner);
      }
    }
  }
  return [...found.entries()].map(([m, pid]) => ({ mint: new PublicKey(m), programId: pid }));
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
  await ctx.provider.sendAndConfirm(new Transaction().add(ix));
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
      .rpc();
    execLog = await program.account.executionLog.fetch(execPda);
  }

  const plan = hasPlan ? await program.account.assetPlan.fetch(assetPlanPda(vault)) : null;
  const mints = await collectMints(connection, vault, plan);

  // 2. begin_token_dist per mint (freeze each residual). No token_program arg.
  for (const { mint, programId } of mints) {
    const tdPda = tokenDistPda(vault, mint);
    const td = await program.account.tokenDist.fetchNullable(tdPda);
    if (td) continue;
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
      .rpc();
  }

  // 3. specific bequests, in ascending index order (the program enforces per-mint order).
  if (plan) {
    for (let j = 0; j < plan.assignments.length; j++) {
      if (bitSet(plan.paidMask, j)) continue;
      const a = plan.assignments[j];
      const benWallet = beneficiaries[a.beneficiaryIndex].wallet;

      // Specific-SOL bequest (zero-pubkey sentinel) → dedicated lamport ix, no ATAs.
      if (a.mint.equals(PublicKey.default)) {
        await program.methods
          .executeSpecificSol(j)
          .accountsPartial({
            payer,
            vaultConfig: vault,
            executionLog: execPda,
            assetPlan: assetPlanPda(vault),
            beneficiary: benWallet,
          })
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
        .rpc();
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
      .rpc();
  }

  // 5. finalize once SOL + specific masks are full.
  execLog = await program.account.executionLog.fetch(execPda);
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
      .rpc();
  }

  // 6. token residual pro-rata shares, batched (runs even post-finalize).
  for (const { mint, programId } of mints) {
    const tdPda = tokenDistPda(vault, mint);
    const td = await program.account.tokenDist.fetchNullable(tdPda);
    if (!td) continue;
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
        .rpc();
    }
  }

  // 7. close each TokenDist once its residual mask is full (dust → largest benef).
  for (const { mint, programId } of mints) {
    const tdPda = tokenDistPda(vault, mint);
    const td = await program.account.tokenDist.fetchNullable(tdPda);
    if (!td) continue;
    if (bigMask(td.paidMask) !== fullMask(benCount)) continue;
    const vaultAta = getAssociatedTokenAddressSync(mint, vault, true, programId);
    const maxIdx = largestShareIndex(beneficiaries);
    const maxWallet = beneficiaries[maxIdx].wallet;
    let dust = 0n;
    try {
      const acc = await getAccount(connection, vaultAta, 'confirmed', programId);
      dust = acc.amount;
    } catch {
      dust = 0n;
    }
    let dustAta = null;
    if (dust > 0n) {
      dustAta = getAssociatedTokenAddressSync(mint, maxWallet, false, programId);
      await ensureAta(ctx, dustAta, mint, maxWallet, programId);
    }
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
      .rpc();
  }

  const finalCfg = await program.account.vaultConfig.fetch(vault);
  return { action: finalCfg.executed ? 'executed' : 'cranked' };
}
