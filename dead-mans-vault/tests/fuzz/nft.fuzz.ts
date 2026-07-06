// Phase 3c — P7: whole-NFT specific bequest (an NFT = a mint with decimals 0,
// supply 1). The whole supply is carried as the specific, so the token residual
// snapshot is 0: execute_token_shares pays nothing and close_token_dist succeeds
// with NO dust (largest_benef_ata = None). Also asserts the on-chain guard that
// rejects two NFT assignments for one mint (DuplicateNftAssignment). See
// docs/FUZZ-HARNESS-PLAN.md. LiteSVM + fast-check; clock warped past the PRODUCTION
// deadline. One property per file (native-memory reset per process).

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
  OFF_TOKENDIST_SNAPSHOT,
  warpClockTo,
  tokenDistPda,
  tokenBal,
  isClosed,
  gcAfter,
  expectBadTx,
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

const nftArb = fc.integer({ min: 1, max: 4 }).chain((n) =>
  fc.record({
    n: fc.constant(n),
    shares: sharesArb(n),
    nftBenef: fc.integer({ min: 0, max: n - 1 }),
    extra: fc.integer({ min: 2_000_000, max: 5_000_000_000 }), // SOL for pro-rata
  })
);

describe("fuzz — whole-NFT specific bequest (LiteSVM + fast-check)", () => {
  it("P7 nft: whole supply pays exactly 1, 0-residual close, owner-close succeeds", async function () {
    this.timeout(300_000);
    await fc.assert(
      fc.asyncProperty(
        nftArb,
        gcAfter(async (c) => {
          const V = await makeVault(c.n, c.shares, 0n, BigInt(c.extra));
          const { svm, owner, cranker, benes, pdas, assetPlan } = V;
          // NFT = decimals 0, supply 1, held by the vault.
          const { mint, vaultAta } = fundVaultToken(svm, owner, pdas.vault, 0, 1n);

          // plan: one whole-NFT bequest to beneficiary nftBenef
          send(
            svm,
            await program.methods
              .setAssetPlan([{ mint, amount: new BN(1), beneficiaryIndex: c.nftBenef, isNft: true }])
              .accountsPartial({ owner: owner.publicKey, vaultConfig: pdas.vault, heartbeatRecord: pdas.heartbeat, assetPlan, systemProgram: SystemProgram.programId })
              .transaction(),
            owner
          );

          warpClockTo(svm, readI64LE(svm, pdas.heartbeat, OFF_HEARTBEAT_LAST) + BigInt(INTERVAL) + BigInt(GRACE) + 5n);

          send(
            svm,
            await program.methods
              .beginExecution()
              .accountsPartial({ payer: cranker.publicKey, vaultConfig: pdas.vault, heartbeatRecord: pdas.heartbeat, executionLog: pdas.execution, assetPlan, systemProgram: SystemProgram.programId })
              .transaction(),
            owner,
            [cranker]
          );

          // begin_token_dist(nft) → snapshot = balance(1) − Σspecific(1) = 0
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
          expect(readU64LE(svm, tokenDist, OFF_TOKENDIST_SNAPSHOT), "nft residual snapshot = 0").to.equal(0n);

          const beneAtas = makeBeneAtas(svm, owner, mint, benes.map((b) => b.publicKey));

          // whole-NFT specific → heir gets exactly 1
          send(
            svm,
            await program.methods
              .executeSpecificAsset(0)
              .accountsPartial({ payer: cranker.publicKey, vaultConfig: pdas.vault, executionLog: pdas.execution, assetPlan, mint, tokenDist, vaultAta, beneficiaryAta: beneAtas[c.nftBenef], tokenProgram: TOKEN_PROGRAM_ID })
              .transaction(),
            owner,
            [cranker]
          );
          expect(tokenBal(svm, beneAtas[c.nftBenef]), "NFT delivered (=1)").to.equal(1n);

          // SOL pro-rata + finalize (both masks now full)
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

          // token residual (snapshot 0) — pays nothing, but sets the mask so close proceeds
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

          // close token dist — no dust (whole supply was the specific)
          send(
            svm,
            await program.methods
              .closeTokenDist()
              .accountsPartial({ payer: cranker.publicKey, owner: owner.publicKey, vaultConfig: pdas.vault, mint, vaultAta, tokenDist, largestBenefAta: null, tokenProgram: TOKEN_PROGRAM_ID })
              .transaction(),
            owner,
            [cranker]
          );
          expect(isClosed(svm, tokenDist), "token_dist closed").to.equal(true);
          expect(isClosed(svm, vaultAta), "vault NFT ATA closed").to.equal(true);

          // owner-close succeeds — which the program only permits when
          // open_token_dists == 0 (else TokensRemain). So a green close IS the
          // open_token_dists→0 proof. Plan present → pass it; SOL dust → largest share.
          const solDust = bal(svm, pdas.vault) - rentFor(svm, accountDataLen(svm, pdas.vault));
          send(
            svm,
            await program.methods
              .closeExecutedVaultByOwner()
              .accountsPartial({ owner: owner.publicKey, vaultConfig: pdas.vault, heartbeatRecord: pdas.heartbeat, executionLog: pdas.execution, assetPlan, largestBenef: solDust > 0n ? benes[largestShareIdx(c.shares)].publicKey : null })
              .transaction(),
            owner
          );
          expect(isClosed(svm, pdas.vault), "vault core PDA closed by owner").to.equal(true);
          expect(tokenBal(svm, beneAtas[c.nftBenef]), "NFT stays with the heir after close").to.equal(1n);
        })
      ),
      { numRuns: 12, endOnFailure: true }
    );
  });

  it("P7b: two NFT assignments for one mint → DuplicateNftAssignment (6031)", async function () {
    this.timeout(120_000);
    const { svm, owner, pdas, assetPlan } = await makeVault(2, [5000, 5000], 0n, 3_000_000n);
    const { mint } = fundVaultToken(svm, owner, pdas.vault, 0, 1n);
    await expectBadTx(
      svm,
      program.methods
        .setAssetPlan([
          { mint, amount: new BN(1), beneficiaryIndex: 0, isNft: true },
          { mint, amount: new BN(1), beneficiaryIndex: 1, isNft: true },
        ])
        .accountsPartial({ owner: owner.publicKey, vaultConfig: pdas.vault, heartbeatRecord: pdas.heartbeat, assetPlan, systemProgram: SystemProgram.programId })
        .transaction(),
      owner,
      [],
      { code: 6031, name: "DuplicateNftAssignment" }
    );
  });
});
