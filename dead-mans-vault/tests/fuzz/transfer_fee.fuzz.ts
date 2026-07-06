// Phase 3b — P6: Token-2022 transfer-fee residual close (the documented "sticky"
// regression). See docs/STRESS-TESTING-PLAN.md §3b. Same LiteSVM + fast-check setup
// as the other properties; clock warped past the PRODUCTION deadline.
//
// A transfer-fee mint withholds a fee in the DESTINATION account on every transfer.
// Depositing into the vault ATA therefore leaves withheld fees inside it, and
// Token-2022 refuses to CloseAccount an account that still holds withheld fees — so
// the on-chain close_token_dist (a bare CloseAccount) reverts, open_token_dists stays
// >0, and the owner-close would revert TokensRemain. The fix (shipped in all three
// real crankers) is a CLIENT-side pre-instruction: HarvestWithheldTokensToMint on the
// vault ATA before the close. This property proves BOTH sides: sticky without harvest,
// clean with it, plus exact conservation net of fees.
//
// One property per file (per-file process → LiteSVM native memory resets between
// files). gcAfter + endOnFailure + byte-offset reads + 2 GB heap, per the harness rules.

import { expect } from "chai";
import fc from "fast-check";
import {
  BN, SystemProgram, Transaction, Keypair, PublicKey,
  program, send, bal, rentFor, accountDataLen, decode,
  readU64LE, readI64LE, OFF_HEARTBEAT_LAST, OFF_EXEC_SOL_SNAPSHOT, OFF_TOKENDIST_SNAPSHOT,
  warpClockTo, tokenDistPda, tokenBal, isClosed, ataFor, createAtaIx, mintToIx, gcAfter, TxError,
} from "./harness";
import { INTERVAL, GRACE, sharesArb, largestShareIdx, makeVault } from "./setup";
import {
  TOKEN_2022_PROGRAM_ID, getMintLen, ExtensionType,
  createInitializeTransferFeeConfigInstruction, createInitializeMint2Instruction,
  createTransferCheckedWithFeeInstruction, createHarvestWithheldTokensToMintInstruction,
  getTransferFeeAmount, unpackAccount,
} from "@solana/spl-token";

const T = TOKEN_2022_PROGRAM_ID;
const MAX_FEE = 10n ** 18n; // effectively uncapped → depFee == floor(D*bps/10000)

/** Transfer-fee `withheld_amount` on a token account (0 if absent). */
function withheldOf(svm: any, ata: PublicKey): bigint {
  const a = svm.getAccount(ata.toBase58()) as any;
  if (!a || !a.data) return 0n;
  const info: any = { data: Buffer.from(Uint8Array.from(a.data)), owner: T, lamports: Number(a.lamports ?? 0), executable: false, rentEpoch: 0 };
  const tf = getTransferFeeAmount(unpackAccount(ata, info, T));
  return tf ? BigInt(tf.withheldAmount.toString()) : 0n;
}

/** Create a Token-2022 transfer-fee mint (owner = mint + fee + withdraw authority). */
function createFeeMint(svm: any, owner: Keypair, mintKp: Keypair, decimals: number, feeBps: number) {
  const len = getMintLen([ExtensionType.TransferFeeConfig]);
  send(svm, new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: owner.publicKey, newAccountPubkey: mintKp.publicKey, lamports: Number(rentFor(svm, len)), space: len, programId: T }),
    createInitializeTransferFeeConfigInstruction(mintKp.publicKey, owner.publicKey, owner.publicKey, feeBps, MAX_FEE, T),
    createInitializeMint2Instruction(mintKp.publicKey, decimals, owner.publicKey, null, T),
  ), owner, [mintKp]);
}

const feeArb = fc.integer({ min: 1, max: 4 }).chain((n) =>
  fc.record({
    n: fc.constant(n),
    shares: sharesArb(n),
    decimals: fc.constantFrom(0, 6, 9),
    feeBps: fc.integer({ min: 50, max: 500 }),          // 0.5%–5%
    depTokens: fc.bigInt({ min: 1_000_000n, max: 1_000_000_000_000n }),
  })
);

describe("fuzz — Token-2022 transfer-fee residual close (LiteSVM + fast-check)", () => {
  it("P6 transfer-fee: withheld deposit fee makes close sticky; harvest unsticks it; conservation net of fees", async function () {
    this.timeout(300_000);
    await fc.assert(
      fc.asyncProperty(feeArb, gcAfter(async (c) => {
        const D = c.depTokens;
        // Token-2022 calculate_fee rounds UP: ceil(amount*bps/10000), capped at maxFee.
        // transfer_checked_with_fee asserts the passed fee equals this exactly, so a
        // floor here would make the deposit revert. maxFee is huge → never caps.
        const depFee = (D * BigInt(c.feeBps) + 9999n) / 10000n;
        expect(depFee > 0n, "deposit fee must be > 0 to exercise the regression").to.equal(true);

        // Vault with SOL (so the SOL leg finalizes) + a fee mint funded via a
        // fee-bearing deposit transfer → vault ATA accrues `depFee` withheld.
        const V = await makeVault(c.n, c.shares, 0n, 2_000_000_000n);
        const { svm, owner, cranker, benes, pdas } = V;
        const mintKp = Keypair.generate();
        const mint = mintKp.publicKey;
        createFeeMint(svm, owner, mintKp, c.decimals, c.feeBps);

        const ownerAta = ataFor(mint, owner.publicKey, T);
        send(svm, new Transaction().add(createAtaIx(owner.publicKey, owner.publicKey, mint, T).ix, mintToIx(mint, ownerAta, owner.publicKey, D, T)), owner);
        const vaultAta = ataFor(mint, pdas.vault, T);
        send(svm, new Transaction().add(
          createAtaIx(owner.publicKey, pdas.vault, mint, T).ix,
          createTransferCheckedWithFeeInstruction(ownerAta, mint, vaultAta, owner.publicKey, D, c.decimals, depFee, [], T),
        ), owner);
        expect(withheldOf(svm, vaultAta), "vault ATA withheld == deposit fee").to.equal(depFee);
        expect(tokenBal(svm, vaultAta), "vault ATA net amount == D − fee").to.equal(D - depFee);

        // warp past the production deadline
        warpClockTo(svm, readI64LE(svm, pdas.heartbeat, OFF_HEARTBEAT_LAST) + BigInt(INTERVAL) + BigInt(GRACE) + 5n);

        // begin_execution (no plan) → snapshot SOL residual
        send(svm, await program.methods.beginExecution().accountsPartial({ payer: cranker.publicKey, vaultConfig: pdas.vault, heartbeatRecord: pdas.heartbeat, executionLog: pdas.execution, assetPlan: null, systemProgram: SystemProgram.programId }).transaction(), owner, [cranker]);

        // begin_token_dist → snapshot = vault ATA net amount (excludes withheld)
        const tokenDist = tokenDistPda(pdas.vault, mint);
        send(svm, await program.methods.beginTokenDist().accountsPartial({ payer: cranker.publicKey, vaultConfig: pdas.vault, executionLog: pdas.execution, mint, vaultAta, assetPlan: null, tokenDist, systemProgram: SystemProgram.programId }).transaction(), owner, [cranker]);
        const snapshot = readU64LE(svm, tokenDist, OFF_TOKENDIST_SNAPSHOT);
        expect(snapshot, "token snapshot == D − depositFee (withheld excluded)").to.equal(D - depFee);

        // beneficiary ATAs + token residual pro-rata
        const beneAtas = benes.map((b) => ataFor(mint, b.publicKey, T));
        const atx = new Transaction();
        for (const b of benes) atx.add(createAtaIx(owner.publicKey, b.publicKey, mint, T).ix);
        send(svm, atx, owner);
        send(svm, await program.methods.executeTokenShares(Buffer.from(benes.map((_, i) => i)))
          .accountsPartial({ payer: cranker.publicKey, vaultConfig: pdas.vault, tokenDist, mint, vaultAta, tokenProgram: T })
          .remainingAccounts(beneAtas.map((pk) => ({ pubkey: pk, isWritable: true, isSigner: false })))
          .transaction(), owner, [cranker]);

        // SOL leg + finalize (close_token_dist requires executed)
        send(svm, await program.methods.executeSolShares(Buffer.from(benes.map((_, i) => i))).accountsPartial({ payer: cranker.publicKey, vaultConfig: pdas.vault, executionLog: pdas.execution }).remainingAccounts(benes.map((b) => ({ pubkey: b.publicKey, isWritable: true, isSigner: false }))).transaction(), owner, [cranker]);
        send(svm, await program.methods.finalizeExecution().accountsPartial({ payer: cranker.publicKey, vaultConfig: pdas.vault, executionLog: pdas.execution, assetPlan: null }).transaction(), owner, [cranker]);
        expect(decode(svm, "vaultConfig", pdas.vault).executed, "executed").to.equal(true);

        // Conservation of the transferred residual: every distributed base unit is
        // now either spendable (amount) or withheld in a beneficiary ATA. Σ == Σt_i
        // == snapshot − dust. (Robust to per-transfer fee rounding.)
        const perShare = c.shares.map((s) => (snapshot * BigInt(s)) / 10000n);
        const dust = snapshot - perShare.reduce((a, b) => a + b, 0n);
        const sumBene = () => beneAtas.reduce((a, pk) => a + tokenBal(svm, pk) + withheldOf(svm, pk), 0n);
        expect(sumBene(), "Σ(bene amount+withheld) == snapshot − dust").to.equal(snapshot - dust);
        expect(tokenBal(svm, vaultAta), "vault ATA spendable drained to dust").to.equal(dust);
        expect(withheldOf(svm, vaultAta), "vault ATA still holds the withheld deposit fee").to.equal(depFee);

        const largest = largestShareIdx(c.shares);
        const buildClose = () => program.methods.closeTokenDist().accountsPartial({
          payer: cranker.publicKey, owner: owner.publicKey, vaultConfig: pdas.vault, mint, vaultAta, tokenDist,
          largestBenefAta: dust > 0n ? beneAtas[largest] : null, tokenProgram: T,
        }).transaction();

        // (1) STICKY: close WITHOUT harvest reverts — Token-2022 refuses to close an
        // account holding withheld fees. This is a token-program failure (custom
        // error 0x23), NOT a DMV Anchor code, so we assert on the token program.
        let stuck = false;
        try {
          send(svm, await buildClose(), owner, [cranker]);
        } catch (e: any) {
          stuck = true;
          const hay = [e?.message, ...((e as TxError)?.logs ?? [])].join("\n");
          expect(hay.includes("0x23") || (hay.includes(T.toBase58()) && /fail/i.test(hay)), `sticky close should fail in the token program, got:\n${hay}`).to.equal(true);
        }
        expect(stuck, "close_token_dist WITHOUT harvest must revert on withheld fees").to.equal(true);

        // (2) HARVEST unsticks it: HarvestWithheldTokensToMint(vault ATA → mint) then close.
        const harvestClose = new Transaction().add(createHarvestWithheldTokensToMintInstruction(mint, [vaultAta], T));
        for (const ix of (await buildClose()).instructions) harvestClose.add(ix);
        send(svm, harvestClose, owner, [cranker]);
        expect(isClosed(svm, tokenDist), "token_dist closed").to.equal(true);
        expect(isClosed(svm, vaultAta), "vault ATA closed").to.equal(true);
        expect(decode(svm, "vaultConfig", pdas.vault).openTokenDists.toString(), "open_token_dists → 0").to.equal("0");

        // (3) Conservation net of fees, post-close: the dust was swept to the largest
        // beneficiary and the deposit fee was harvested to the mint — so every base
        // unit of the ORIGINAL deposit D is accounted for across beneficiaries + fee.
        expect(sumBene() + depFee, "Σ(bene amount+withheld) + depositFee == D").to.equal(D);

        // (4) Owner-close now succeeds (open_token_dists == 0 → no TokensRemain).
        const solSnap = readU64LE(svm, pdas.execution, OFF_EXEC_SOL_SNAPSHOT);
        const solDust = solSnap - c.shares.reduce((a, s) => a + (solSnap * BigInt(s)) / 10000n, 0n);
        send(svm, await program.methods.closeExecutedVaultByOwner().accountsPartial({
          owner: owner.publicKey, vaultConfig: pdas.vault, heartbeatRecord: pdas.heartbeat, executionLog: pdas.execution,
          assetPlan: null, largestBenef: solDust > 0n ? benes[largestShareIdx(c.shares)].publicKey : null,
        }).transaction(), owner);
        expect(isClosed(svm, pdas.vault), "vault core PDA closed by owner").to.equal(true);
        void bal; void accountDataLen; void BN;
      })),
      { numRuns: 12, endOnFailure: true }
    );
  });
});
