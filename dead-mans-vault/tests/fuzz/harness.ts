// LiteSVM fuzz harness — shared setup + helpers.
// See tasks/FUZZ-HARNESS-PLAN.md. In-process SVM (no validator); clock-warp lets
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

/** Fresh in-process SVM with the program loaded. */
export function newSvm(): LiteSVM {
  const svm = new LiteSVM();
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
export function accountDataLen(svm: LiteSVM, pk: PublicKey): number {
  const a = svm.getAccount(pk.toBase58() as any) as any;
  return a?.data?.length ?? 0;
}
/** Decode an account from raw bytes via the anchor coder (camelCase name, e.g.
 *  "vaultConfig" / "executionLog" / "heartbeatRecord"). */
export function decode<T = any>(svm: LiteSVM, name: string, pk: PublicKey): T {
  const a = svm.getAccount(pk.toBase58() as any) as any;
  return program.coder.accounts.decode(name, Buffer.from(a.data)) as T;
}
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

export { Keypair, PublicKey, SystemProgram, Transaction, BN };
