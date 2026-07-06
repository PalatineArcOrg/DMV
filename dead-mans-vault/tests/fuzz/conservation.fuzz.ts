// Phase 1 property tests — SOL conservation & idempotency (invariants I1/I2/I4).
// See docs/FUZZ-HARNESS-PLAN.md. Randomised vaults are driven through the real
// permissionless SOL-distribution flow on an in-process LiteSVM, with the clock
// warped past the PRODUCTION deadline (1-day interval + 7-day grace).
//
// The owner is the fee payer for every tx (including the permissionless cranks) so
// the cranker's balance moves ONLY by program lamport transfers — this keeps the
// bounty assertion exact. numRuns is modest (P1=15, P2=15); each run spins up a
// fresh SVM + loads the .so.

import { expect } from "chai";
import fc from "fast-check";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  BN,
  program,
  newSvm,
  vaultPdas,
  airdrop,
  bal,
  rentFor,
  accountDataLen,
  decode,
  readU64LE,
  readI64LE,
  OFF_HEARTBEAT_LAST,
  OFF_EXEC_SOL_SNAPSHOT,
  warpClockTo,
  send,
  expectTxError,
  gcAfter,
  FEE_WALLET,
} from "./harness";

const INTERVAL = 86_400; // 1 day (production floor)
const GRACE = 604_800; // 7 days (production floor)
const MAX_BOUNTY = 100_000_000; // MAX_KEEPER_BOUNTY_LAMPORTS (0.1 SOL)

interface Ctx {
  n: number;
  shares: number[];
  bounty: number;
  extra: number;
}

// n share_bps parts, each >= 0, summing to EXACTLY 10000 (what initialize_vault
// requires). Built from sorted random cut points.
function sharesArb(n: number) {
  if (n === 1) return fc.constant<number[]>([10000]);
  return fc
    .array(fc.integer({ min: 0, max: 10000 }), { minLength: n - 1, maxLength: n - 1 })
    .map((cuts) => {
      const sorted = [0, ...cuts.slice().sort((a, b) => a - b), 10000];
      const shares: number[] = [];
      for (let i = 1; i < sorted.length; i++) shares.push(sorted[i] - sorted[i - 1]);
      return shares;
    });
}

const vaultArb = fc.integer({ min: 1, max: 20 }).chain((n) =>
  fc.record({
    n: fc.constant(n),
    shares: sharesArb(n),
    bounty: fc.integer({ min: 0, max: MAX_BOUNTY }),
    // snapshot = deposit − bounty = extra, so snapshot is always in [2e6, 2e10].
    extra: fc.integer({ min: 2_000_000, max: 20_000_000_000 }),
  })
);

// Build helpers (anchor client → web3.js Transaction; sent via LiteSVM in `send`).
async function txInit(c: Ctx, owner: Keypair, agent: Keypair, benes: Keypair[], pdas: any) {
  return program.methods
    .initializeVault({
      agentPubkey: agent.publicKey,
      heartbeatInterval: new BN(INTERVAL),
      gracePeriod: new BN(GRACE),
      beneficiaries: benes.map((b, i) => ({ wallet: b.publicKey, shareBps: c.shares[i] })),
      isMutable: true,
      keeperBounty: new BN(c.bounty),
    })
    .accountsPartial({
      owner: owner.publicKey,
      vaultConfig: pdas.vault,
      heartbeatRecord: pdas.heartbeat,
      feeRecipient: FEE_WALLET,
      systemProgram: SystemProgram.programId,
    })
    .transaction();
}

async function txBegin(cranker: Keypair, pdas: any) {
  return program.methods
    .beginExecution()
    .accountsPartial({
      payer: cranker.publicKey,
      vaultConfig: pdas.vault,
      heartbeatRecord: pdas.heartbeat,
      executionLog: pdas.execution,
      assetPlan: null,
      systemProgram: SystemProgram.programId,
    })
    .transaction();
}

async function txSolShares(cranker: Keypair, pdas: any, idx: number[], wallets: PublicKey[]) {
  return program.methods
    .executeSolShares(Buffer.from(idx))
    .accountsPartial({ payer: cranker.publicKey, vaultConfig: pdas.vault, executionLog: pdas.execution })
    .remainingAccounts(wallets.map((pk) => ({ pubkey: pk, isWritable: true, isSigner: false })))
    .transaction();
}

async function txFinalize(cranker: Keypair, pdas: any) {
  return program.methods
    .finalizeExecution()
    .accountsPartial({ payer: cranker.publicKey, vaultConfig: pdas.vault, executionLog: pdas.execution, assetPlan: null })
    .transaction();
}

// init + deposit + warp past deadline + begin_execution; returns live state.
async function beginState(c: Ctx) {
  const owner = Keypair.generate();
  const agent = Keypair.generate();
  const cranker = Keypair.generate();
  const benes = Array.from({ length: c.n }, () => Keypair.generate());

  const svm = newSvm();
  const pdas = vaultPdas(owner.publicKey);

  const bounty = BigInt(c.bounty);
  const deposit = bounty + BigInt(c.extra);

  airdrop(svm, owner.publicKey, deposit + 1_000_000_000n);
  airdrop(svm, cranker.publicKey, 1_000_000_000n);
  airdrop(svm, FEE_WALLET, 1_000_000n); // ensure the fee-CPI recipient exists
  for (const b of benes) airdrop(svm, b.publicKey, 10_000_000n); // pre-fund so credits are rent-safe

  send(svm, await txInit(c, owner, agent, benes, pdas), owner);

  send(
    svm,
    new Transaction().add(
      SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: pdas.vault, lamports: Number(deposit) })
    ),
    owner
  );

  // rent_min for the vault's actual data length — matches the program's
  // Rent::get().minimum_balance(vault_info.data_len()).
  const rentMin = rentFor(svm, accountDataLen(svm, pdas.vault));
  const V = bal(svm, pdas.vault);
  const expectedSnapshot = V - rentMin - bounty;

  const lastHb = readI64LE(svm, pdas.heartbeat, OFF_HEARTBEAT_LAST);
  warpClockTo(svm, lastHb + BigInt(INTERVAL) + BigInt(GRACE) + 5n);

  // owner is fee payer; cranker signs as `payer` (pays execution_log rent)
  send(svm, await txBegin(cranker, pdas), owner, [cranker]);

  const snapshot = readU64LE(svm, pdas.execution, OFF_EXEC_SOL_SNAPSHOT);
  const shares = c.shares.map((s) => BigInt(s));
  const expected = shares.map((s) => (snapshot * s) / 10000n);
  const sumExpected = expected.reduce((a, b) => a + b, 0n);
  const dust = snapshot - sumExpected;

  return { svm, owner, cranker, benes, pdas, bounty, rentMin, snapshot, expected, dust, expectedSnapshot };
}

describe("fuzz — SOL conservation & idempotency (LiteSVM + fast-check)", () => {
  it("P1 conservation: exact floor shares, Σ ≤ snapshot, dust<n, vault retains rent+bounty+dust", async function () {
    this.timeout(120_000);
    await fc.assert(
      fc.asyncProperty(vaultArb, gcAfter(async (c: Ctx) => {
        const { svm, owner, cranker, benes, pdas, bounty, rentMin, snapshot, expected, dust, expectedSnapshot } =
          await beginState(c);

        // on-chain snapshot must equal the independent TS recomputation
        expect(snapshot).to.equal(expectedSnapshot);
        expect(dust >= 0n && dust < BigInt(c.n), `dust ${dust} n ${c.n}`).to.equal(true);

        const before = benes.map((b) => bal(svm, b.publicKey));
        send(svm, await txSolShares(cranker, pdas, benes.map((_, i) => i), benes.map((b) => b.publicKey)), owner, [cranker]);
        const after = benes.map((b) => bal(svm, b.publicKey));

        let totalPaid = 0n;
        for (let i = 0; i < c.n; i++) {
          const d = after[i] - before[i];
          expect(d, `payout[${i}]`).to.equal(expected[i]);
          totalPaid += d;
        }
        expect(totalPaid <= snapshot, "conservation Σ ≤ snapshot").to.equal(true);
        expect(snapshot - totalPaid).to.equal(dust);
        expect(bal(svm, pdas.vault)).to.equal(rentMin + bounty + dust);
      })),
      // endOnFailure: skip shrinking — each run spins up a fresh LiteSVM whose native
      // memory only frees on process exit, so a shrink storm would OOM the heap. The
      // raw counterexample (seed) is still reported and reproducible.
      { numRuns: 15, endOnFailure: true }
    );
  });

  it("P2 idempotency: replay no-ops, finalize gated by NotAllSharesPaid, bounty→finalizer once", async function () {
    this.timeout(120_000);
    await fc.assert(
      fc.asyncProperty(vaultArb, gcAfter(async (c: Ctx) => {
        const { svm, owner, cranker, benes, pdas, bounty, rentMin, dust } = await beginState(c);
        const idx = benes.map((_, i) => i);
        const shares = (idxs: number[]) => txSolShares(cranker, pdas, idxs, idxs.map((i) => benes[i].publicKey));

        // finalize with an empty mask → rejected
        await expectTxError(async () => send(svm, await txFinalize(cranker, pdas), owner, [cranker]), "NotAllSharesPaid");

        if (c.n >= 2) {
          // partial mask: pay all-but-last, finalize still rejected, then pay last
          const part = idx.slice(0, c.n - 1);
          send(svm, await shares(part), owner, [cranker]);
          await expectTxError(async () => send(svm, await txFinalize(cranker, pdas), owner, [cranker]), "NotAllSharesPaid");
          send(svm, await shares([c.n - 1]), owner, [cranker]);
        } else {
          send(svm, await shares(idx), owner, [cranker]);
        }

        // idempotency: replay full set + reversed set → zero net movement
        const beneBefore = benes.map((b) => bal(svm, b.publicKey));
        const vaultBefore = bal(svm, pdas.vault);
        send(svm, await shares(idx), owner, [cranker]);
        send(svm, await shares(idx.slice().reverse()), owner, [cranker]);
        for (let i = 0; i < c.n; i++) expect(bal(svm, benes[i].publicKey)).to.equal(beneBefore[i]);
        expect(bal(svm, pdas.vault)).to.equal(vaultBefore);

        // finalize exactly once → bounty = min(bounty, available) to the finalizer
        const available = vaultBefore - rentMin; // == bounty + dust
        const expectedBounty = bounty < available ? bounty : available;
        const crankerBefore = bal(svm, cranker.publicKey);
        send(svm, await txFinalize(cranker, pdas), owner, [cranker]);
        const crankerAfter = bal(svm, cranker.publicKey);
        expect(crankerAfter - crankerBefore, "bounty to finalizer").to.equal(expectedBounty);

        expect(decode(svm, "vaultConfig", pdas.vault).executed).to.equal(true);
        expect(bal(svm, pdas.vault)).to.equal(rentMin + dust);
      })),
      { numRuns: 15, endOnFailure: true }
    );
  });
});
