// LiteSVM fuzz harness — shared setup + helpers.
// See docs/FUZZ-HARNESS-PLAN.md. In-process SVM (no validator); clock-warp lets
// us test the REAL production config (1-day interval / 7-day grace) instantly.
//
// Integration: litesvm@1.2.1's TS surface uses @solana/kit types and its send
// path expects kit transactions, while this project's client is anchor 0.32 +
// @solana/web3.js v1. anchor-litesvm only supports litesvm 0.3.x, so instead we:
//   - build instructions with the normal anchor client (…​.transaction()),
//   - sign a web3.js legacy tx and hand its serialized bytes to LiteSVM's native
//     sendLegacyTransaction (bypassing the kit layer), and
//   - decode accounts from raw bytes via program.coder (no live connection).
// The stub provider's connection is never used.

import { AnchorProvider, Program, BN, Wallet } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  MINT_SIZE,
  ACCOUNT_SIZE,
  AccountLayout,
  TOKEN_PROGRAM_ID,
  createInitializeMint2Instruction,
  createInitializeAccount3Instruction,
  createMintToInstruction,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import * as path from "path";
import type { DeadMansVault } from "../../target/types/dead_mans_vault";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const IDL = require("../../target/idl/dead_mans_vault.json");

export const PROGRAM_ID = new PublicKey(
  "GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb"
);
export const FEE_WALLET = new PublicKey(
  "98x9Rn63Ne8xbL3w522zgbuYg9bdHn7cRqJQVCUZUFsp"
);
const SO_PATH = path.resolve(__dirname, "../../target/deploy/dead_mans_vault.so");

// One shared program for building instructions + decoding. The provider's
// connection is NEVER hit (we send through LiteSVM and decode raw bytes), so the
// bogus URL is intentional.
const stubProvider = new AnchorProvider(
  new Connection("http://127.0.0.1:1"),
  new Wallet(Keypair.generate()),
  { commitment: "processed" }
);
export const program = new Program<DeadMansVault>(IDL, stubProvider);

/** Fresh in-process SVM with the program loaded. Transaction history is disabled
 *  (withTransactionHistory(0)) — the property tests submit hundreds of txs across
 *  many short-lived SVMs, and retaining every tx + its logs otherwise balloons the
 *  heap. Failure metadata is still returned synchronously from sendTransaction, so
 *  error detection is unaffected. */
export function newSvm(): LiteSVM {
  // Release the previous run's native SVM memory before allocating a new one.
  // LiteSVM holds large native buffers that JS GC reclaims lazily; without this
  // the property loop builds enough pressure to intermittently corrupt account
  // reads (a decoded BN's toString() then yields "…NaN"). Requires --expose-gc.
  (global as any).gc?.();
  const svm = new LiteSVM().withTransactionHistory(0n as any);
  svm.addProgramFromFile(PROGRAM_ID.toBase58() as any, SO_PATH);
  return svm;
}

export function vaultPdas(owner: PublicKey) {
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), owner.toBuffer()],
    PROGRAM_ID
  );
  const [heartbeat] = PublicKey.findProgramAddressSync(
    [Buffer.from("heartbeat"), vault.toBuffer()],
    PROGRAM_ID
  );
  const [execution] = PublicKey.findProgramAddressSync(
    [Buffer.from("execution"), vault.toBuffer()],
    PROGRAM_ID
  );
  return { vault, heartbeat, execution };
}

// --- litesvm bridges (its native API takes @solana/kit string/bigint types) ---
export function airdrop(svm: LiteSVM, pk: PublicKey, lamports: bigint) {
  svm.airdrop(pk.toBase58() as any, lamports as any);
}
export function bal(svm: LiteSVM, pk: PublicKey): bigint {
  return (svm.getBalance(pk.toBase58() as any) as bigint | null) ?? 0n;
}
export function rentFor(svm: LiteSVM, dataLen: number): bigint {
  return svm.minimumBalanceForRentExemption(BigInt(dataLen) as any) as bigint;
}
/** Copy an account's data into a fresh, JS-owned Buffer, coercing each element
 *  through a new Uint8Array so the decode never aliases LiteSVM's native memory. */
function accountBytes(svm: LiteSVM, pk: PublicKey): Buffer | null {
  const a = svm.getAccount(pk.toBase58() as any) as any;
  if (!a || !a.data) return null;
  return Buffer.from(Uint8Array.from(a.data as ArrayLike<number>));
}
export function accountDataLen(svm: LiteSVM, pk: PublicKey): number {
  return accountBytes(svm, pk)?.length ?? 0;
}
/** Decode an account from raw bytes via the anchor coder (camelCase name, e.g.
 *  "vaultConfig" / "executionLog" / "heartbeatRecord"). */
export function decode<T = any>(svm: LiteSVM, name: string, pk: PublicKey): T {
  const buf = accountBytes(svm, pk);
  if (!buf) throw new Error(`account ${pk.toBase58()} has no data to decode as ${name}`);
  return program.coder.accounts.decode(name, buf) as T;
}
/** Read a little-endian u64/i64 field directly from account bytes. Bypasses the
 *  anchor BN, whose toString() was observed to intermittently yield "…NaN" for a
 *  large value under the property loop; native readBig*64LE returns a clean bigint.
 *  Field offsets (after the 8-byte anchor discriminator):
 *    HeartbeatRecord.last_heartbeat = 8 + 32(vault)            = 40  (i64)
 *    ExecutionLog.sol_snapshot      = 8 + 32(vault)            = 40  (u64)
 *    TokenDist.snapshot             = 8 + 32(vault) + 32(mint) = 72  (u64) */
export function readU64LE(svm: LiteSVM, pk: PublicKey, offset: number): bigint {
  const buf = accountBytes(svm, pk);
  if (!buf || buf.length < offset + 8) throw new Error(`${pk.toBase58()} too short for u64@${offset}`);
  return buf.readBigUInt64LE(offset);
}
export function readI64LE(svm: LiteSVM, pk: PublicKey, offset: number): bigint {
  const buf = accountBytes(svm, pk);
  if (!buf || buf.length < offset + 8) throw new Error(`${pk.toBase58()} too short for i64@${offset}`);
  return buf.readBigInt64LE(offset);
}
/** Read small unsigned integer fields (masks, flags, counters) straight from the
 *  account bytes — never through the anchor BN (whose toString() was observed to
 *  intermittently return "…NaN" under the property loop). Used by P9 to read
 *  sol_paid_mask/paid_mask (u32), open_token_dists (u16) and the executed/
 *  has_asset_plan bool bytes at fixed offsets after the beneficiaries Vec. */
export function readU32LE(svm: LiteSVM, pk: PublicKey, offset: number): number {
  const buf = accountBytes(svm, pk);
  if (!buf || buf.length < offset + 4) throw new Error(`${pk.toBase58()} too short for u32@${offset}`);
  return buf.readUInt32LE(offset);
}
export function readU16LE(svm: LiteSVM, pk: PublicKey, offset: number): number {
  const buf = accountBytes(svm, pk);
  if (!buf || buf.length < offset + 2) throw new Error(`${pk.toBase58()} too short for u16@${offset}`);
  return buf.readUInt16LE(offset);
}
export function readU8(svm: LiteSVM, pk: PublicKey, offset: number): number {
  const buf = accountBytes(svm, pk);
  if (!buf || buf.length < offset + 1) throw new Error(`${pk.toBase58()} too short for u8@${offset}`);
  return buf.readUInt8(offset);
}
export const OFF_HEARTBEAT_LAST = 40;
export const OFF_EXEC_SOL_SNAPSHOT = 40;
export const OFF_TOKENDIST_SNAPSHOT = 72;
/** Jump the clock's unix timestamp (leaves slot/epoch intact — the program reads
 *  Clock.unix_timestamp for the deadline). */
export function warpClockTo(svm: LiteSVM, unixTs: bigint) {
  const clock = svm.getClock();
  clock.unixTimestamp = unixTs;
  svm.setClock(clock);
}

export class TxError extends Error {
  logs: string[];
  constructor(msg: string, logs: string[]) {
    super(msg);
    this.logs = logs;
  }
}

/** Sign a web3.js legacy tx and submit its serialized bytes to LiteSVM. `feePayer`
 *  is charged the fee; `signers` are any additional required signers. Throws
 *  TxError (with program logs) on a failed transaction. */
export function send(
  svm: LiteSVM,
  tx: Transaction,
  feePayer: Keypair,
  signers: Keypair[] = []
) {
  tx.feePayer = feePayer.publicKey;
  // Advance the blockhash so otherwise-identical txs (e.g. an idempotent replay,
  // or a retried finalize) get distinct signatures — LiteSVM does not auto-advance
  // it, and duplicate signatures are rejected at the tx layer.
  svm.expireBlockhash();
  tx.recentBlockhash = svm.latestBlockhash() as any;
  const all = [feePayer, ...signers.filter((s) => !s.publicKey.equals(feePayer.publicKey))];
  tx.sign(...all);
  const res = (svm as any).inner.sendLegacyTransaction(
    new Uint8Array(tx.serialize())
  );
  if (res instanceof FailedTransactionMetadata) {
    const logs = (res.meta()?.logs() as string[]) ?? [];
    throw new TxError(res.err().toString(), logs);
  }
  return res;
}

/** Assert an ix throws an anchor error whose name/number `needle` appears in the
 *  failed-tx logs or message. */
export async function expectTxError(fn: () => any, needle: string) {
  try {
    await fn();
  } catch (e: any) {
    const hay = [e?.message, ...(e?.logs ?? [])].join("\n");
    if (hay.includes(needle)) return;
    throw new Error(`expected error "${needle}" but got:\n${hay}`);
  }
  throw new Error(`expected error "${needle}" but the call succeeded`);
}

// --- token / asset-plan helpers (Phase 2) -----------------------------------

export const SENTINEL_MINT = PublicKey.default; // zero-pubkey → specific-SOL bequest

export function assetPlanPda(vault: PublicKey) {
  const [pk] = PublicKey.findProgramAddressSync(
    [Buffer.from("asset_plan"), vault.toBuffer()],
    PROGRAM_ID
  );
  return pk;
}
export function tokenDistPda(vault: PublicKey, mint: PublicKey) {
  const [pk] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_dist"), vault.toBuffer(), mint.toBuffer()],
    PROGRAM_ID
  );
  return pk;
}
/** Canonical associated-token address (allowOwnerOffCurve for the vault PDA). */
export function ataFor(mint: PublicKey, owner: PublicKey, programId = TOKEN_PROGRAM_ID) {
  return getAssociatedTokenAddressSync(mint, owner, true, programId);
}

/** Create + init a mint (payer funds rent & is the mint authority). The returned
 *  tx must be sent with `mintKp` as an extra signer. */
export function createMintTx(
  svm: LiteSVM,
  payer: PublicKey,
  mintKp: Keypair,
  decimals: number,
  programId = TOKEN_PROGRAM_ID
): Transaction {
  const rent = rentFor(svm, MINT_SIZE);
  return new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer,
      newAccountPubkey: mintKp.publicKey,
      lamports: Number(rent),
      space: MINT_SIZE,
      programId,
    }),
    createInitializeMint2Instruction(mintKp.publicKey, decimals, payer, null, programId)
  );
}
/** Idempotent-safe create of an ATA (returns {ata, ix}); pass ix into a tx. */
export function createAtaIx(
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  programId = TOKEN_PROGRAM_ID
) {
  const ata = ataFor(mint, owner, programId);
  return {
    ata,
    ix: createAssociatedTokenAccountInstruction(payer, ata, owner, mint, programId),
  };
}
export function mintToIx(
  mint: PublicKey,
  dest: PublicKey,
  authority: PublicKey,
  amount: bigint,
  programId = TOKEN_PROGRAM_ID
) {
  return createMintToInstruction(mint, dest, authority, amount, [], programId);
}
/** SPL token-account balance (0 if the account is absent/uninitialised). */
export function tokenBal(svm: LiteSVM, ata: PublicKey): bigint {
  const buf = accountBytes(svm, ata);
  if (!buf || buf.length < ACCOUNT_SIZE) return 0n;
  return AccountLayout.decode(buf).amount as bigint;
}
/** True once an account has been closed/deallocated (LiteSVM reports exists:false
 *  and/or zero lamports). */
export function isClosed(svm: LiteSVM, pk: PublicKey): boolean {
  const a = svm.getAccount(pk.toBase58() as any) as any;
  return !a || a.exists === false || (a.lamports ?? 0n) === 0n;
}

/** Create a NON-canonical, vault-owned token account for `mint` (a plain token
 *  account, NOT the ATA) — used to prove the InvalidVaultAta anti-spoof guard.
 *  `acctKp` must sign the returned tx. */
export function createTokenAccountTx(
  svm: LiteSVM,
  payer: PublicKey,
  acctKp: Keypair,
  mint: PublicKey,
  owner: PublicKey,
  programId = TOKEN_PROGRAM_ID
): Transaction {
  const rent = rentFor(svm, ACCOUNT_SIZE);
  return new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer,
      newAccountPubkey: acctKp.publicKey,
      lamports: Number(rent),
      space: ACCOUNT_SIZE,
      programId,
    }),
    createInitializeAccount3Instruction(acctKp.publicKey, mint, owner, programId)
  );
}

/** Assert `fn` throws a TxError carrying a specific Anchor error. Matches on the
 *  canonical `Error Number: <code>` / `Error Code: <name>` that Anchor logs, so a
 *  tx that fails for the WRONG reason is NOT a false pass. Pass the numeric code
 *  (preferred) and/or the PascalCase name. */
export async function expectAnchorError(
  fn: () => any,
  opts: { code?: number; name?: string }
) {
  let threw = false;
  try {
    await fn();
  } catch (e: any) {
    threw = true;
    const hay = [e?.message, ...(e?.logs ?? [])].join("\n");
    const okCode = opts.code != null && hay.includes(`Error Number: ${opts.code}`);
    const okName = opts.name != null && hay.includes(`Error Code: ${opts.name}`);
    if (okCode || okName) return;
    throw new Error(
      `expected Anchor error ${opts.name ?? ""}/${opts.code ?? ""} but got:\n${hay}`
    );
  }
  if (!threw) throw new Error(`expected Anchor error ${opts.name ?? opts.code} but the call succeeded`);
}

/** Build `txPromise`, then assert that submitting it raises a specific Anchor
 *  error. Centralises the await so callers never hand a Promise to send(). */
export async function expectBadTx(
  svm: LiteSVM,
  txPromise: Promise<Transaction>,
  feePayer: Keypair,
  signers: Keypair[],
  err: { code?: number; name?: string }
) {
  const tx = await txPromise;
  await expectAnchorError(() => send(svm, tx, feePayer, signers), err);
}

/** Wrap a fast-check predicate so `global.gc()` runs after EVERY invocation —
 *  including ones that throw. Critical: a flaky failure sends fast-check into
 *  shrinking, which re-runs the predicate dozens of times; without a gc on the
 *  throw path each failed re-run's heavy JS objects (Transactions, buffers, the
 *  SVM wrapper) accumulate and OOM the heap before the failure is even reported.
 *  Requires --expose-gc (set in the test:fuzz script). */
export function gcAfter<T>(fn: (arg: T) => Promise<void>): (arg: T) => Promise<void> {
  return async (arg: T) => {
    try {
      await fn(arg);
    } finally {
      (global as any).gc?.();
    }
  };
}

export { Keypair, PublicKey, SystemProgram, Transaction, BN, TOKEN_PROGRAM_ID };
