// DMV keeper bot — scan the program for expired vaults and crank them.
//
// Fully standalone: point it at an RPC + a funded keypair and it discovers work
// on-chain (no registry, no API, no DMV server). Profitable by design:
//   - finalize_execution pays the vault's keeper bounty (default 0.005 SOL),
//   - close_executed_vault (24h after execution) pays the core-PDA rents
//     (~0.01–0.03 SOL) that would otherwise strand with a dead owner.
//
// Safety: every instruction is permissionless AND fund-safe — the program
// computes payouts from frozen on-chain state; a keeper can never redirect
// funds. Worst case racing another keeper: your tx no-ops and you lose a fee.
import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Program, Wallet } from '@coral-xyz/anchor';
import { crankVault, cleanupExecutedVault, heartbeatPda } from './crank.js';

const RPC_URL = process.env.RPC_URL;
const KEYPAIR_PATH = process.env.KEYPAIR_PATH;
const POLL_MS = Number(process.env.POLL_MS || 30_000);
const ONCE = process.argv.includes('--once');
// Rent-claim close of executed vaults. On by default (the mainnet economic
// incentive). Set CLOSE_EXECUTED=0 for a CRANK-ONLY keeper: it still fires the
// switch (distributes expired vaults) but never closes an executed vault to
// collect the core-PDA rents — leaving those for the owner. Recommended on
// devnet, where the close window is only 60s and an always-on keeper would
// otherwise sweep an owner's own rent before they can reclaim it.
const CLOSE_EXECUTED = process.env.CLOSE_EXECUTED !== '0';

if (!RPC_URL || !KEYPAIR_PATH) {
  console.error('Usage: RPC_URL=<url> KEYPAIR_PATH=<keypair.json> node src/index.js [--once]');
  process.exit(1);
}

const idl = JSON.parse(readFileSync(new URL('../idl/dead_mans_vault.json', import.meta.url), 'utf8'));
const keeper = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(KEYPAIR_PATH, 'utf8'))),
);
const connection = new Connection(RPC_URL, 'confirmed');
const provider = new AnchorProvider(connection, new Wallet(keeper), { commitment: 'confirmed' });
const program = new Program(idl, provider);
const ctx = { connection, provider, program, keeper };

const short = (pk) => pk.toBase58().slice(0, 8);

/**
 * Discriminator-filtered scan of every VaultConfig, decoding each account
 * individually. Anchor's `.all()` throws on the FIRST undecodable account —
 * and devnet still carries legacy-layout vaults from older program versions —
 * which would kill the whole tick. Undecodable accounts are skipped instead.
 */
async function scanVaults() {
  const filter = program.coder.accounts.memcmp('vaultConfig');
  const raw = await connection.getProgramAccounts(program.programId, {
    filters: [{ memcmp: { offset: filter.offset ?? 0, bytes: filter.bytes } }],
  });
  const vaults = [];
  for (const { pubkey, account } of raw) {
    try {
      vaults.push({
        publicKey: pubkey,
        account: program.coder.accounts.decode('vaultConfig', account.data),
      });
    } catch {
      // legacy/foreign layout — not a crankable vault
    }
  }
  return vaults;
}

async function tick() {
  const started = Date.now();
  const vaults = await scanVaults();
  let due = 0, cleaned = 0;

  for (const { publicKey: vault, account: cfg } of vaults) {
    try {
      if (cfg.executed) {
        // Executed → optionally do the post-window rent-collecting close. When
        // CLOSE_EXECUTED is off (crank-only), leave the executed vault (and its
        // rents) for the owner. Its distribution already completed. An early
        // close attempt fails preflight (CloseDelayNotElapsed) at no cost.
        if (!CLOSE_EXECUTED) continue;
        const r = await cleanupExecutedVault(ctx, vault, cfg);
        if (r === 'closed') {
          cleaned++;
          console.log(`[keeper] closed ${short(vault)} — rents collected`);
        }
        continue;
      }
      if (!cfg.active) continue;

      const hb = await program.account.heartbeatRecord.fetch(heartbeatPda(program.programId, vault));
      const deadline =
        hb.lastHeartbeat.toNumber() + cfg.heartbeatInterval.toNumber() + cfg.gracePeriod.toNumber();
      if (Math.floor(Date.now() / 1000) < deadline) continue;

      due++;
      console.log(`[keeper] cranking ${short(vault)} (deadline passed ${Math.floor(Date.now() / 1000) - deadline}s ago)`);
      const r = await crankVault(ctx, vault, cfg);
      console.log(`[keeper] ${short(vault)} -> ${r}`);
    } catch (e) {
      console.log(`[keeper] ${short(vault)} error: ${e?.message ?? e}`);
    }
  }

  const bal = (await connection.getBalance(keeper.publicKey)) / 1e9;
  console.log(
    `[keeper] tick: ${vaults.length} vaults, ${due} due, ${cleaned} closed, ` +
      `balance ${bal.toFixed(4)} SOL (${Date.now() - started}ms)`,
  );
}

console.log(`[keeper] ${keeper.publicKey.toBase58()} watching program ${program.programId.toBase58()} (${CLOSE_EXECUTED ? 'crank + rent-close' : 'CRANK-ONLY, no rent-close'})`);
if (ONCE) {
  await tick();
} else {
  for (;;) {
    try {
      await tick();
    } catch (e) {
      console.log(`[keeper] tick failed: ${e?.message ?? e}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
