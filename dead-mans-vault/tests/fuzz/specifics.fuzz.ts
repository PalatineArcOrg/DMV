// Phase 2 — P3: specific bequests (SPL + specific-SOL) carve-out + conservation
// (invariants I3/I6/I8). See docs/FUZZ-HARNESS-PLAN.md. Same LiteSVM + fast-check
// setup as Phase 1; clock warped past the PRODUCTION deadline. Owner is fee payer
// on every tx so beneficiary/cranker balances move ONLY by program transfers.
//
// P3 caps n at 5 so one execute_{sol,token}_shares call carries every beneficiary
// (Phase 1 exercises the pro-rata split up to n=20). P4 (theft battery) lives in a
// SEPARATE file (theft.fuzz.ts) so `yarn test:fuzz` runs it in its own process —
// LiteSVM native memory is reclaimed only on process exit, so keeping P3+P4 in one
// process pushed V8 over a 2 GB heap.

import { expect } from "chai";
import fc from "fast-check";
import {
  BN,
  SystemProgram,
  program,
  send,
  bal,
  rentFor,
  accountDataLen,
  decode,
  readU64LE,
  readI64LE,
  OFF_HEARTBEAT_LAST,
  OFF_EXEC_SOL_SNAPSHOT,
  OFF_TOKENDIST_SNAPSHOT,
  warpClockTo,
  tokenDistPda,
  tokenBal,
  isClosed,
  gcAfter,
  SENTINEL_MINT,
  TOKEN_PROGRAM_ID,
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

const p3Arb = fc.integer({ min: 1, max: 5 }).chain((n) =>
  fc.record({
    n: fc.constant(n),
    shares: sharesArb(n),
    decimals: fc.constantFrom(0, 6, 9),
    bal: fc.bigInt({ min: 1n, max: 1_000_000_000_000n }),
    sFrac: fc.integer({ min: 0, max: 100 }), // specific = floor(bal * sFrac/100)
    tokBenef: fc.integer({ min: 0, max: n - 1 }),
    withSol: fc.boolean(),
    // min 1: a specific-SOL bequest must be > 0 (the program rejects a 0-amount
    // sentinel with InvalidSolBequest); extra ≥ 2e6 so floor(extra*1/100) ≥ 1.
    solFrac: fc.integer({ min: 1, max: 40 }), // specific-SOL = floor(extra * solFrac/100)
    solBenef: fc.integer({ min: 0, max: n - 1 }),
    bounty: fc.integer({ min: 0, max: MAX_BOUNTY }),
    extra: fc.integer({ min: 2_000_000, max: 20_000_000_000 }),
  })
);

describe("fuzz — specific bequests conservation (LiteSVM + fast-check)", () => {
  it("P3 conservation: specifics carved first, residual splits pro-rata, Σ = balance", async function () {
    this.timeout(300_000);
    await fc.assert(
      fc.asyncProperty(p3Arb, gcAfter(async (c) => {
        const bounty = BigInt(c.bounty);
        const S = (c.bal * BigInt(c.sFrac)) / 100n; // specific token amount ≤ bal
        const solSpecific = c.withSol ? (BigInt(c.extra) * BigInt(c.solFrac)) / 100n : 0n;
        const deposit = bounty + solSpecific + BigInt(c.extra);

        const V = await makeVault(c.n, c.shares, bounty, deposit);
        const { svm, owner, cranker, benes, pdas, assetPlan } = V;
        const { mint, vaultAta } = fundVaultToken(svm, owner, pdas.vault, c.decimals, c.bal);

        // asset plan: token specific (+ optional specific-SOL sentinel)
        const assignments: any[] = [
          { mint, amount: new BN(S.toString()), beneficiaryIndex: c.tokBenef, isNft: false },
        ];
        if (c.withSol)
          assignments.push({ mint: SENTINEL_MINT, amount: new BN(solSpecific.toString()), beneficiaryIndex: c.solBenef, isNft: false });
        send(
          svm,
          await program.methods
            .setAssetPlan(assignments)
            .accountsPartial({ owner: owner.publicKey, vaultConfig: pdas.vault, heartbeatRecord: pdas.heartbeat, assetPlan, systemProgram: SystemProgram.programId })
            .transaction(),
          owner
        );

        // warp past deadline
        warpClockTo(svm, readI64LE(svm, pdas.heartbeat, OFF_HEARTBEAT_LAST) + BigInt(INTERVAL) + BigInt(GRACE) + 5n);

        // begin_execution — cross-check sol_snapshot carve-outs
        const rentMin = rentFor(svm, accountDataLen(svm, pdas.vault));
        const vaultLamports = bal(svm, pdas.vault);
        send(
          svm,
          await program.methods
            .beginExecution()
            .accountsPartial({ payer: cranker.publicKey, vaultConfig: pdas.vault, heartbeatRecord: pdas.heartbeat, executionLog: pdas.execution, assetPlan, systemProgram: SystemProgram.programId })
            .transaction(),
          owner,
          [cranker]
        );
        const solSnapshot = readU64LE(svm, pdas.execution, OFF_EXEC_SOL_SNAPSHOT);
        expect(solSnapshot, "sol_snapshot carve-out").to.equal(vaultLamports - rentMin - solSpecific - bounty);

        // begin_token_dist — snapshot = balance − Σspecific(mint)
        const tokenDist = tokenDistPda(pdas.vault, mint);
        send(
          svm,
          await program.methods
            .beginTokenDist()
            .accountsPartial({ payer: cranker.publicKey, vaultConfig: pdas.vault, executionLog: pdas.execution, mint, vaultAta, assetPlan, tokenDist, systemProgram: SystemProgram.programId })
            .transaction(),
          owner,
          [cranker]
        );
        const snapshot = readU64LE(svm, tokenDist, OFF_TOKENDIST_SNAPSHOT);
        expect(snapshot, "token snapshot = bal − specific").to.equal(c.bal - S);

        const beneAtas = makeBeneAtas(svm, owner, mint, benes.map((b) => b.publicKey));

        // (a) specific token bequest pays exactly min(S, available=bal) = S, isolated.
        const tokBefore = tokenBal(svm, beneAtas[c.tokBenef]);
        send(
          svm,
          await program.methods
            .executeSpecificAsset(0)
            .accountsPartial({ payer: cranker.publicKey, vaultConfig: pdas.vault, executionLog: pdas.execution, assetPlan, mint, tokenDist, vaultAta, beneficiaryAta: beneAtas[c.tokBenef], tokenProgram: TOKEN_PROGRAM_ID })
            .transaction(),
          owner,
          [cranker]
        );
        expect(tokenBal(svm, beneAtas[c.tokBenef]) - tokBefore, "specific token delta").to.equal(S);

        // (a) specific-SOL bequest pays exactly min(amount, available), isolated.
        if (c.withSol) {
          const solBefore = bal(svm, benes[c.solBenef].publicKey);
          const availBefore = bal(svm, pdas.vault) - rentMin;
          send(
            svm,
            await program.methods
              .executeSpecificSol(1)
              .accountsPartial({ payer: cranker.publicKey, vaultConfig: pdas.vault, executionLog: pdas.execution, assetPlan, beneficiary: benes[c.solBenef].publicKey })
              .transaction(),
            owner,
            [cranker]
          );
          const paidSol = bal(svm, benes[c.solBenef].publicKey) - solBefore;
          expect(paidSol, "specific-SOL delta").to.equal(solSpecific < availBefore ? solSpecific : availBefore);
        }

        // SOL pro-rata + finalize (finalize needs both masks full)
        send(
          svm,
          await program.methods
            .executeSolShares(Buffer.from(benes.map((_, i) => i)))
            .accountsPartial({ payer: cranker.publicKey, vaultConfig: pdas.vault, executionLog: pdas.execution })
            .remainingAccounts(benes.map((b) => ({ pubkey: b.publicKey, isWritable: true, isSigner: false })))
            .transaction(),
          owner,
          [cranker]
        );
        send(
          svm,
          await program.methods
            .finalizeExecution()
            .accountsPartial({ payer: cranker.publicKey, vaultConfig: pdas.vault, executionLog: pdas.execution, assetPlan })
            .transaction(),
          owner,
          [cranker]
        );
        expect(decode(svm, "vaultConfig", pdas.vault).executed, "executed").to.equal(true);

        // token residual pro-rata
        send(
          svm,
          await program.methods
            .executeTokenShares(Buffer.from(benes.map((_, i) => i)))
            .accountsPartial({ payer: cranker.publicKey, vaultConfig: pdas.vault, tokenDist, mint, vaultAta, tokenProgram: TOKEN_PROGRAM_ID })
            .remainingAccounts(beneAtas.map((pk) => ({ pubkey: pk, isWritable: true, isSigner: false })))
            .transaction(),
          owner,
          [cranker]
        );

        // (c) per-beneficiary token payout = specific(if k) + floor(snap*share/1e4) + dust(if largest)
        const largest = largestShareIdx(c.shares);
        const perShare = c.shares.map((s) => (snapshot * BigInt(s)) / 10000n);
        const dust = snapshot - perShare.reduce((a, b) => a + b, 0n);
        // Pre-close each beneficiary holds specific(if the token bequest) + floor share;
        // the dust is still in the vault ATA (swept to the largest-share benef on close).
        for (let i = 0; i < c.n; i++) {
          expect(tokenBal(svm, beneAtas[i]), `token payout[${i}] pre-dust`).to.equal(
            (i === c.tokBenef ? S : 0n) + perShare[i]
          );
        }

        // close token dist → dust swept to largest-share beneficiary, vault ATA closed
        send(
          svm,
          await program.methods
            .closeTokenDist()
            .accountsPartial({ payer: cranker.publicKey, owner: owner.publicKey, vaultConfig: pdas.vault, mint, vaultAta, tokenDist, largestBenefAta: dust > 0n ? beneAtas[largest] : null, tokenProgram: TOKEN_PROGRAM_ID })
            .transaction(),
          owner,
          [cranker]
        );
        expect(isClosed(svm, tokenDist), "token_dist closed").to.equal(true);
        expect(isClosed(svm, vaultAta), "vault ATA closed").to.equal(true);

        // (d) conservation: every base unit of the token balance ended up with a
        // beneficiary — Σ balances == original balance, nothing lost or minted.
        const total = beneAtas.reduce((a, pk) => a + tokenBal(svm, pk), 0n);
        expect(total, "Σ beneficiary token balances == original balance").to.equal(c.bal);
        // and the largest-share beneficiary specifically absorbed the dust
        expect(
          tokenBal(svm, beneAtas[largest]),
          "largest-share token incl dust"
        ).to.equal((largest === c.tokBenef ? S : 0n) + perShare[largest] + dust);
      })),
      // endOnFailure: skip shrinking. This property builds a heavy SVM per run; a
      // flaky read (LiteSVM corrupts account reads under native-memory pressure)
      // would otherwise send fast-check into a shrink storm that re-runs the heavy
      // predicate ~80× and OOMs the heap. Low n + numRuns keep pressure under the
      // corruption threshold; endOnFailure bounds the damage if one slips through.
      { numRuns: 12, endOnFailure: true }
    );
  });
});
