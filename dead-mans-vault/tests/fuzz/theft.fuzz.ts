// Phase 2 — P4: the adversarial "theft must revert" battery (invariant I5). Each
// case asserts a SPECIFIC Anchor error code, so a tx that fails for the wrong reason
// is not a false pass. See docs/FUZZ-HARNESS-PLAN.md. Split from P3 into its own file
// so `yarn test:fuzz` runs it in a separate process (LiteSVM native memory is freed
// only on process exit; P3+P4 in one process pushed V8 over a 2 GB heap).

import fc from "fast-check";
import {
  BN,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  program,
  send,
  warpClockTo,
  readI64LE,
  OFF_HEARTBEAT_LAST,
  tokenDistPda,
  ataFor,
  createMintTx,
  createAtaIx,
  createTokenAccountTx,
  expectBadTx,
  gcAfter,
  SENTINEL_MINT,
  TOKEN_PROGRAM_ID,
} from "./harness";
import { INTERVAL, GRACE, makeVault, fundVaultToken, makeBeneAtas } from "./setup";

// A 2-beneficiary vault (6000/4000) holding `bal` of a token, plan-assigned via
// `assignments` (use mint placeholder "T"), cranked up to just-after begin_token_dist.
async function tokenPlanState(assignments: any[], bal = 1000n, deposit = 1_000_000_000n) {
  const V = await makeVault(2, [6000, 4000], 0n, deposit);
  const { svm, owner, cranker, pdas, assetPlan } = V;
  const { mint, vaultAta } = fundVaultToken(svm, owner, pdas.vault, 0, bal);
  const asg = assignments.map((a) => (a.mint === "T" ? { ...a, mint } : a));
  send(
    svm,
    await program.methods
      .setAssetPlan(asg.map((a) => ({ mint: a.mint, amount: new BN(a.amount.toString()), beneficiaryIndex: a.beneficiaryIndex, isNft: !!a.isNft })))
      .accountsPartial({ owner: owner.publicKey, vaultConfig: pdas.vault, heartbeatRecord: pdas.heartbeat, assetPlan, systemProgram: SystemProgram.programId })
      .transaction(),
    owner
  );
  warpClockTo(svm, readI64LE(svm, pdas.heartbeat, OFF_HEARTBEAT_LAST) + BigInt(INTERVAL) + BigInt(GRACE) + 5n);
  send(svm, await program.methods.beginExecution().accountsPartial({ payer: cranker.publicKey, vaultConfig: pdas.vault, heartbeatRecord: pdas.heartbeat, executionLog: pdas.execution, assetPlan, systemProgram: SystemProgram.programId }).transaction(), owner, [cranker]);
  const tokenDist = tokenDistPda(pdas.vault, mint);
  send(svm, await program.methods.beginTokenDist().accountsPartial({ payer: cranker.publicKey, vaultConfig: pdas.vault, executionLog: pdas.execution, mint, vaultAta, assetPlan, tokenDist, systemProgram: SystemProgram.programId }).transaction(), owner, [cranker]);
  return { ...V, mint, vaultAta, tokenDist };
}

// 2-benef vault with a specific-SOL sentinel bequest of `amt` to beneficiary 0,
// cranked to just-after begin_execution.
async function tokenPlanStateSol(amt: bigint) {
  const V = await makeVault(2, [6000, 4000], 0n, 1_000_000_000n);
  const { svm, owner, cranker, pdas, assetPlan } = V;
  send(svm, await program.methods.setAssetPlan([{ mint: SENTINEL_MINT, amount: new BN(amt.toString()), beneficiaryIndex: 0, isNft: false }]).accountsPartial({ owner: owner.publicKey, vaultConfig: pdas.vault, heartbeatRecord: pdas.heartbeat, assetPlan, systemProgram: SystemProgram.programId }).transaction(), owner);
  warpClockTo(svm, readI64LE(svm, pdas.heartbeat, OFF_HEARTBEAT_LAST) + BigInt(INTERVAL) + BigInt(GRACE) + 5n);
  send(svm, await program.methods.beginExecution().accountsPartial({ payer: cranker.publicKey, vaultConfig: pdas.vault, heartbeatRecord: pdas.heartbeat, executionLog: pdas.execution, assetPlan, systemProgram: SystemProgram.programId }).transaction(), owner, [cranker]);
  return V;
}

describe("fuzz — theft resistance (LiteSVM + fast-check)", () => {
  it("P4 theft: index-equality, anti-spoof, ordering & double-pay all revert with the right code", async function () {
    this.timeout(300_000);
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 900 }), gcAfter(async (amt) => {
        const S = BigInt(amt);
        const acctSpecAsset = (st: any, vaultAta: PublicKey, beneficiaryAta: PublicKey) =>
          ({ payer: st.cranker.publicKey, vaultConfig: st.pdas.vault, executionLog: st.pdas.execution, assetPlan: st.assetPlan, mint: st.mint, tokenDist: st.tokenDist, vaultAta, beneficiaryAta, tokenProgram: TOKEN_PROGRAM_ID });

        // 1. execute_specific_asset with a beneficiary ATA owned by the WRONG wallet
        //    (assignment 0 → beneficiaries[1]; hand it beneficiaries[0]'s ATA).
        {
          const st = await tokenPlanState([{ mint: "T", amount: S, beneficiaryIndex: 1 }]);
          const wrongAta = makeBeneAtas(st.svm, st.owner, st.mint, [st.benes[0].publicKey])[0];
          await expectBadTx(st.svm, program.methods.executeSpecificAsset(0).accountsPartial(acctSpecAsset(st, st.vaultAta, wrongAta)).transaction(), st.owner, [st.cranker], { code: 6023, name: "BeneficiaryMismatch" });
        }

        // 2. SUBSTITUTED (non-canonical) vault ATA — the CRITICAL anti-spoof guard.
        {
          const st = await tokenPlanState([{ mint: "T", amount: S, beneficiaryIndex: 1 }]);
          const rightAta = makeBeneAtas(st.svm, st.owner, st.mint, [st.benes[1].publicKey])[0];
          const fakeVaultAcct = Keypair.generate();
          send(st.svm, createTokenAccountTx(st.svm, st.owner.publicKey, fakeVaultAcct, st.mint, st.pdas.vault), st.owner, [fakeVaultAcct]);
          await expectBadTx(st.svm, program.methods.executeSpecificAsset(0).accountsPartial(acctSpecAsset(st, fakeVaultAcct.publicKey, rightAta)).transaction(), st.owner, [st.cranker], { code: 6034, name: "InvalidVaultAta" });
        }

        // 3. pay specific j+1 before j for the SAME mint → SpecificOutOfOrder
        {
          const st = await tokenPlanState([
            { mint: "T", amount: S, beneficiaryIndex: 0 },
            { mint: "T", amount: S, beneficiaryIndex: 1 },
          ]);
          const b1Ata = makeBeneAtas(st.svm, st.owner, st.mint, [st.benes[1].publicKey])[0];
          await expectBadTx(st.svm, program.methods.executeSpecificAsset(1).accountsPartial(acctSpecAsset(st, st.vaultAta, b1Ata)).transaction(), st.owner, [st.cranker], { code: 6026, name: "SpecificOutOfOrder" });
        }

        // 4. pay the SAME specific twice → MaskAlreadySet
        {
          const st = await tokenPlanState([{ mint: "T", amount: S, beneficiaryIndex: 1 }]);
          const b1Ata = makeBeneAtas(st.svm, st.owner, st.mint, [st.benes[1].publicKey])[0];
          const build = () => program.methods.executeSpecificAsset(0).accountsPartial(acctSpecAsset(st, st.vaultAta, b1Ata)).transaction();
          send(st.svm, await build(), st.owner, [st.cranker]); // first succeeds
          await expectBadTx(st.svm, build(), st.owner, [st.cranker], { code: 6027, name: "MaskAlreadySet" });
        }

        // 5. execute_specific_sol with the WRONG beneficiary wallet → BeneficiaryMismatch
        //    (assignment says index 0; pass beneficiaries[1] instead)
        {
          const st = await tokenPlanStateSol(S);
          await expectBadTx(st.svm, program.methods.executeSpecificSol(0).accountsPartial({ payer: st.cranker.publicKey, vaultConfig: st.pdas.vault, executionLog: st.pdas.execution, assetPlan: st.assetPlan, beneficiary: st.benes[1].publicKey }).transaction(), st.owner, [st.cranker], { code: 6023, name: "BeneficiaryMismatch" });
        }

        // 6. execute_sol_shares with a WRONG remaining-account wallet → BeneficiaryMismatch
        {
          const V = await makeVault(2, [6000, 4000], 0n, 1_000_000_000n);
          warpClockTo(V.svm, readI64LE(V.svm, V.pdas.heartbeat, OFF_HEARTBEAT_LAST) + BigInt(INTERVAL) + BigInt(GRACE) + 5n);
          send(V.svm, await program.methods.beginExecution().accountsPartial({ payer: V.cranker.publicKey, vaultConfig: V.pdas.vault, heartbeatRecord: V.pdas.heartbeat, executionLog: V.pdas.execution, assetPlan: null, systemProgram: SystemProgram.programId }).transaction(), V.owner, [V.cranker]);
          const imposter = Keypair.generate();
          await expectBadTx(V.svm, program.methods.executeSolShares(Buffer.from([0])).accountsPartial({ payer: V.cranker.publicKey, vaultConfig: V.pdas.vault, executionLog: V.pdas.execution }).remainingAccounts([{ pubkey: imposter.publicKey, isWritable: true, isSigner: false }]).transaction(), V.owner, [V.cranker], { code: 6023, name: "BeneficiaryMismatch" });

          // 7. begin_token_dist for a mint the vault neither holds nor bequeaths →
          //    NothingToDistribute (reuses this plain-SOL vault; both attempts revert).
          const mk = Keypair.generate();
          send(V.svm, createMintTx(V.svm, V.owner.publicKey, mk, 0), V.owner, [mk]);
          const emptyAta = ataFor(mk.publicKey, V.pdas.vault);
          send(V.svm, new Transaction().add(createAtaIx(V.owner.publicKey, V.pdas.vault, mk.publicKey).ix), V.owner);
          const td = tokenDistPda(V.pdas.vault, mk.publicKey);
          await expectBadTx(V.svm, program.methods.beginTokenDist().accountsPartial({ payer: V.cranker.publicKey, vaultConfig: V.pdas.vault, executionLog: V.pdas.execution, mint: mk.publicKey, vaultAta: emptyAta, assetPlan: null, tokenDist: td, systemProgram: SystemProgram.programId }).transaction(), V.owner, [V.cranker], { code: 6040, name: "NothingToDistribute" });
        }

      })),
      // endOnFailure: skip shrinking (each run spins up ~6 LiteSVMs; a shrink storm
      // would OOM). The raw counterexample seed is still reported.
      { numRuns: 12, endOnFailure: true }
    );
  });
});
