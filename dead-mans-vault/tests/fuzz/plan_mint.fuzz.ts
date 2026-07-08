// NEW-1 — set/update_asset_plan reject a bequest whose mint is not a real Mint
// account. A garbage/non-mint assignment can never have its paid bit set (both
// begin_token_dist and execute_specific_asset require the mint to load), so it would
// permanently brick finalize with no post-deadline recovery. The program rejects it
// at plan-set with InvalidPlanMint (6044). Deterministic guard (a validation gate,
// not a distribution property — no fast-check needed). See docs/AUDIT-SCOPE.md.

import { expect } from "chai";
import {
  BN,
  SystemProgram,
  program,
  send,
  isClosed,
  expectBadTx,
  planMintMetas,
  SENTINEL_MINT,
} from "./harness";
import { makeVault, fundVaultToken } from "./setup";

describe("fuzz — plan-mint validation (NEW-1, LiteSVM)", () => {
  it("rejects a non-sentinel mint with NO remaining account → InvalidPlanMint", async () => {
    const { svm, owner, pdas, assetPlan } = await makeVault(2, [6000, 4000], 0n, 1_000_000_000n);
    const { mint } = fundVaultToken(svm, owner, pdas.vault, 6, 1000n);
    await expectBadTx(
      svm,
      program.methods
        .setAssetPlan([{ mint, amount: new BN(1), beneficiaryIndex: 0, isNft: false }])
        .accountsPartial({ owner: owner.publicKey, vaultConfig: pdas.vault, heartbeatRecord: pdas.heartbeat, assetPlan, systemProgram: SystemProgram.programId })
        .transaction(), // no .remainingAccounts → the mint account is never supplied
      owner,
      [],
      { code: 6044, name: "InvalidPlanMint" }
    );
  });

  it("rejects a mint address that is not a token mint (non-token-owned) → InvalidPlanMint", async () => {
    const { svm, owner, pdas, assetPlan } = await makeVault(2, [6000, 4000], 0n, 1_000_000_000n);
    // pdas.vault is a program-owned VaultConfig, not a token-program-owned Mint.
    const fakeMint = pdas.vault;
    await expectBadTx(
      svm,
      program.methods
        .setAssetPlan([{ mint: fakeMint, amount: new BN(1), beneficiaryIndex: 0, isNft: false }])
        .accountsPartial({ owner: owner.publicKey, vaultConfig: pdas.vault, heartbeatRecord: pdas.heartbeat, assetPlan, systemProgram: SystemProgram.programId })
        .remainingAccounts([{ pubkey: fakeMint, isSigner: false, isWritable: false }])
        .transaction(),
      owner,
      [],
      { code: 6044, name: "InvalidPlanMint" }
    );
  });

  it("accepts a real Mint (with remaining account) alongside a SOL-sentinel bequest", async () => {
    const { svm, owner, pdas, assetPlan } = await makeVault(2, [6000, 4000], 0n, 1_000_000_000n);
    const { mint } = fundVaultToken(svm, owner, pdas.vault, 6, 1000n);
    const assignments = [
      { mint, amount: new BN(1), beneficiaryIndex: 0, isNft: false },
      { mint: SENTINEL_MINT, amount: new BN(1000), beneficiaryIndex: 1, isNft: false },
    ];
    send(
      svm,
      await program.methods
        .setAssetPlan(assignments)
        .accountsPartial({ owner: owner.publicKey, vaultConfig: pdas.vault, heartbeatRecord: pdas.heartbeat, assetPlan, systemProgram: SystemProgram.programId })
        .remainingAccounts(planMintMetas(assignments))
        .transaction(),
      owner
    );
    expect(isClosed(svm, assetPlan)).to.equal(false); // plan account created
  });
});
