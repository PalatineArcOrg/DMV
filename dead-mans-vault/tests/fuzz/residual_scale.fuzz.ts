// Phase 3c — P8: token-residual pro-rata dust at scale (n up to 20). A single SPL
// mint, no specific/plan — pure pro-rata residual. Asserts each beneficiary gets
// floor(snapshot*share/1e4), the dust (< n units) sweeps to the largest-share
// beneficiary (ties → lowest index) on close, and Σ beneficiary balances == the
// full balance (conservation). See docs/FUZZ-HARNESS-PLAN.md. One property per file.
//
// n=20 ⇒ 20 beneficiary ATAs + a full crank per run, so numRuns is kept low (8) and
// the *_shares calls are batched ≤8 accounts/tx (the tx-size bound the real crank
// uses) — this stays comfortably under the 2 GB heap test:fuzz sets.

import { expect } from "chai";
import fc from "fast-check";
import {
  SystemProgram,
  program,
  send,
  readU64LE,
  readI64LE,
  OFF_HEARTBEAT_LAST,
  OFF_TOKENDIST_SNAPSHOT,
  warpClockTo,
  tokenDistPda,
  tokenBal,
  isClosed,
  gcAfter,
  TOKEN_PROGRAM_ID,
} from "./harness";
import {
  INTERVAL,
  GRACE,
  sharesArb,
  largestShareIdx,
  makeVault,
  fundVaultToken,
  makeBeneAtas,
} from "./setup";

const BATCH = 8; // ≤8 remaining accounts per execute_*_shares tx (tx-size bound)

const p8Arb = fc.integer({ min: 10, max: 20 }).chain((n) =>
  fc.record({
    n: fc.constant(n),
    shares: sharesArb(n),
    decimals: fc.constantFrom(0, 6, 9),
    bal: fc.bigInt({ min: 1n, max: 1_000_000_000_000n }),
  })
);

describe("fuzz — token-residual dust at scale (LiteSVM + fast-check)", () => {
  it("P8 residual@scale: floor shares, dust<n → largest-share, Σ = balance", async function () {
    this.timeout(300_000);
    await fc.assert(
      fc.asyncProperty(
        p8Arb,
        gcAfter(async (c) => {
          // Focus on the TOKEN residual: no extra SOL (sol_snapshot 0), no bounty, no plan.
          const V = await makeVault(c.n, c.shares, 0n, 0n);
          const { svm, owner, cranker, benes, pdas } = V;
          const { mint, vaultAta } = fundVaultToken(svm, owner, pdas.vault, c.decimals, c.bal);

          warpClockTo(svm, readI64LE(svm, pdas.heartbeat, OFF_HEARTBEAT_LAST) + BigInt(INTERVAL) + BigInt(GRACE) + 5n);

          // begin_execution — no asset plan
          send(
            svm,
            await program.methods
              .beginExecution()
              .accountsPartial({ payer: cranker.publicKey, vaultConfig: pdas.vault, heartbeatRecord: pdas.heartbeat, executionLog: pdas.execution, assetPlan: null, systemProgram: SystemProgram.programId })
              .transaction(),
            owner,
            [cranker]
          );

          const tokenDist = tokenDistPda(pdas.vault, mint);
          send(
            svm,
            await program.methods
              .beginTokenDist()
              .accountsPartial({ payer: cranker.publicKey, vaultConfig: pdas.vault, executionLog: pdas.execution, mint, vaultAta, assetPlan: null, tokenDist, systemProgram: SystemProgram.programId })
              .transaction(),
            owner,
            [cranker]
          );
          const snapshot = readU64LE(svm, tokenDist, OFF_TOKENDIST_SNAPSHOT);
          expect(snapshot, "snapshot = full balance (no specific)").to.equal(c.bal);

          const beneAtas = makeBeneAtas(svm, owner, mint, benes.map((b) => b.publicKey));
          const idx = benes.map((_, i) => i);

          // SOL pro-rata (snapshot 0, sets the mask) — batched ≤8 — then finalize
          for (let i = 0; i < c.n; i += BATCH) {
            const chunk = idx.slice(i, i + BATCH);
            send(
              svm,
              await program.methods
                .executeSolShares(Buffer.from(chunk))
                .accountsPartial({ payer: cranker.publicKey, vaultConfig: pdas.vault, executionLog: pdas.execution })
                .remainingAccounts(chunk.map((j) => ({ pubkey: benes[j].publicKey, isWritable: true, isSigner: false })))
                .transaction(),
              owner,
              [cranker]
            );
          }
          send(
            svm,
            await program.methods
              .finalizeExecution()
              .accountsPartial({ payer: cranker.publicKey, vaultConfig: pdas.vault, executionLog: pdas.execution, assetPlan: null })
              .transaction(),
            owner,
            [cranker]
          );

          // token residual pro-rata — batched ≤8
          for (let i = 0; i < c.n; i += BATCH) {
            const chunk = idx.slice(i, i + BATCH);
            send(
              svm,
              await program.methods
                .executeTokenShares(Buffer.from(chunk))
                .accountsPartial({ payer: cranker.publicKey, vaultConfig: pdas.vault, tokenDist, mint, vaultAta, tokenProgram: TOKEN_PROGRAM_ID })
                .remainingAccounts(chunk.map((j) => ({ pubkey: beneAtas[j], isWritable: true, isSigner: false })))
                .transaction(),
              owner,
              [cranker]
            );
          }

          // (a) each beneficiary got floor(snapshot*share/1e4); (b) dust < n
          const perShare = c.shares.map((s) => (snapshot * BigInt(s)) / 10000n);
          const dust = snapshot - perShare.reduce((a, b) => a + b, 0n);
          expect(dust < BigInt(c.n), `dust (${dust}) < n (${c.n})`).to.equal(true);
          for (let i = 0; i < c.n; i++)
            expect(tokenBal(svm, beneAtas[i]), `residual[${i}] pre-dust`).to.equal(perShare[i]);

          // (c) close → dust to the largest-share beneficiary; Σ == balance; ATA closed
          const largest = largestShareIdx(c.shares);
          send(
            svm,
            await program.methods
              .closeTokenDist()
              .accountsPartial({ payer: cranker.publicKey, owner: owner.publicKey, vaultConfig: pdas.vault, mint, vaultAta, tokenDist, largestBenefAta: dust > 0n ? beneAtas[largest] : null, tokenProgram: TOKEN_PROGRAM_ID })
              .transaction(),
            owner,
            [cranker]
          );
          expect(isClosed(svm, vaultAta), "vault ATA closed").to.equal(true);
          expect(tokenBal(svm, beneAtas[largest]), "largest-share absorbs the dust").to.equal(perShare[largest] + dust);
          const total = beneAtas.reduce((a, pk) => a + tokenBal(svm, pk), 0n);
          expect(total, "Σ beneficiary balances == original balance").to.equal(c.bal);
        })
      ),
      { numRuns: 8, endOnFailure: true }
    );
  });
});
