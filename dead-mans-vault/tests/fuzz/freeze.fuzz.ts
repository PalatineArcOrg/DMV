// Phase 3a property test — freeze-after-deadline (invariant I7).
// See docs/STRESS-TESTING-PLAN.md §Phase 3a. Once now >= deadline
// (= last_heartbeat + heartbeat_interval + grace_period) EVERY owner mutation must
// revert — this is the core safety property of the trustless switch: a post-deadline
// heartbeat / withdraw / revoke would cancel an already-firing distribution.
//   VaultFrozen (6035):     update_vault, withdraw_sol_from_vault, withdraw_from_vault,
//                           revoke_vault, rotate_agent, record_heartbeat.
//   AssetPlanImmutable (6022): set_asset_plan, update_asset_plan.
//
// One property per file (LiteSVM native memory only frees on process exit — the
// per-file `test:fuzz` loop bounds the footprint). Every vault's last_heartbeat is
// pinned to a fixed BASE so all four share ONE deadline D0 under the single SVM clock;
// the exact `>=` boundary is proved by flipping withdraw_sol from success at D0-1 to
// VaultFrozen at exactly D0.

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
  send,
  expectBadTx,
  readI64LE,
  OFF_HEARTBEAT_LAST,
  warpClockTo,
  gcAfter,
  FEE_WALLET,
  assetPlanPda,
  createAtaIx,
  TOKEN_PROGRAM_ID,
} from "./harness";
import { sharesArb, fundVaultToken, INTERVAL, GRACE } from "./setup";

// Fixed init time → every vault's last_heartbeat = BASE → a common deadline D0.
const BASE = 1_700_000_000n;
const D0 = BASE + BigInt(INTERVAL) + BigInt(GRACE);
const VF = { code: 6035, name: "VaultFrozen" };
const API = { code: 6022, name: "AssetPlanImmutable" };
const SOL_BEQUEST = (amount: number) => [
  { mint: PublicKey.default, amount: new BN(amount), beneficiaryIndex: 0, isNft: false },
];

// --- owner/agent instruction builders (anchor client → web3.js Transaction) ------
const txUpdate = (o: Keypair, p: any) =>
  program.methods
    .updateVault({ heartbeatInterval: new BN(700_000), gracePeriod: null, beneficiaries: null })
    .accountsPartial({ owner: o.publicKey, vaultConfig: p.vault, heartbeatRecord: p.heartbeat })
    .transaction();
const txWithdrawSol = (o: Keypair, p: any, amt: number) =>
  program.methods
    .withdrawSolFromVault(new BN(amt))
    .accountsPartial({ owner: o.publicKey, vaultConfig: p.vault, heartbeatRecord: p.heartbeat })
    .transaction();
const txWithdrawTok = (o: Keypair, p: any, mint: PublicKey, vAta: PublicKey, oAta: PublicKey) =>
  program.methods
    .withdrawFromVault(new BN(1))
    .accountsPartial({
      owner: o.publicKey,
      vaultConfig: p.vault,
      heartbeatRecord: p.heartbeat,
      mint,
      sourceTokenAccount: vAta,
      destinationTokenAccount: oAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .transaction();
const txRevoke = (o: Keypair, p: any) =>
  program.methods
    .revokeVault()
    .accountsPartial({ owner: o.publicKey, vaultConfig: p.vault, heartbeatRecord: p.heartbeat, assetPlan: null })
    .transaction();
const txRotate = (o: Keypair, p: any, newAgent: PublicKey) =>
  program.methods
    .rotateAgent(newAgent)
    .accountsPartial({ owner: o.publicKey, vaultConfig: p.vault, heartbeatRecord: p.heartbeat })
    .transaction();
const txHeartbeat = (agent: Keypair, p: any) =>
  program.methods
    .recordHeartbeat({ activeTap: {} })
    .accountsPartial({ agent: agent.publicKey, vaultConfig: p.vault, heartbeatRecord: p.heartbeat })
    .transaction();
const txSetPlan = (o: Keypair, p: any) =>
  program.methods
    .setAssetPlan(SOL_BEQUEST(1000))
    .accountsPartial({
      owner: o.publicKey,
      vaultConfig: p.vault,
      heartbeatRecord: p.heartbeat,
      assetPlan: assetPlanPda(p.vault),
      systemProgram: SystemProgram.programId,
    })
    .transaction();
const txUpdatePlan = (o: Keypair, p: any) =>
  program.methods
    .updateAssetPlan(SOL_BEQUEST(2000))
    .accountsPartial({
      owner: o.publicKey,
      vaultConfig: p.vault,
      heartbeatRecord: p.heartbeat,
      assetPlan: assetPlanPda(p.vault),
    })
    .transaction();
// clear_asset_plan is pre-grace only (VaultFrozen post-deadline); needs an existing plan.
const txClearPlan = (o: Keypair, p: any) =>
  program.methods
    .clearAssetPlan()
    .accountsPartial({
      owner: o.publicKey,
      vaultConfig: p.vault,
      heartbeatRecord: p.heartbeat,
      assetPlan: assetPlanPda(p.vault),
    })
    .transaction();

/** Init a vault inside a shared SVM with last_heartbeat pinned to BASE. */
async function initVault(svm: any, owner: Keypair, agent: Keypair, benes: Keypair[], shares: number[], deposit: bigint) {
  const pdas = vaultPdas(owner.publicKey);
  airdrop(svm, owner.publicKey, deposit + 5_000_000_000n);
  for (const b of benes) airdrop(svm, b.publicKey, 10_000_000n);
  warpClockTo(svm, BASE); // pin last_heartbeat = BASE (init reads Clock.unix_timestamp)
  const initTx = await program.methods
    .initializeVault({
      agentPubkey: agent.publicKey,
      heartbeatInterval: new BN(INTERVAL),
      gracePeriod: new BN(GRACE),
      beneficiaries: benes.map((b, i) => ({ wallet: b.publicKey, shareBps: shares[i] })),
      isMutable: true,
      keeperBounty: new BN(0),
    })
    .accountsPartial({
      owner: owner.publicKey,
      vaultConfig: pdas.vault,
      heartbeatRecord: pdas.heartbeat,
      feeRecipient: FEE_WALLET,
      systemProgram: SystemProgram.programId,
    })
    .transaction();
  send(svm, initTx, owner);
  if (deposit > 0n)
    send(
      svm,
      new Transaction().add(
        SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: pdas.vault, lamports: Number(deposit) })
      ),
      owner
    );
  return pdas;
}

const arb = fc.integer({ min: 1, max: 3 }).chain((n) =>
  fc.record({
    n: fc.constant(n),
    shares: sharesArb(n),
    // seconds past the deadline for the frozen battery (0 ⇒ exactly now == deadline).
    delta: fc.integer({ min: 0, max: 5_000_000 }),
  })
);

describe("fuzz — freeze-after-deadline (LiteSVM + fast-check)", () => {
  it("P5 freeze: every owner mutation reverts once now >= deadline; boundary flips at exactly the deadline", async function () {
    this.timeout(120_000);
    await fc.assert(
      fc.asyncProperty(
        arb,
        gcAfter(async (c: { n: number; shares: number[]; delta: number }) => {
          const svm = newSvm();
          airdrop(svm, FEE_WALLET, 1_000_000n);
          const mkBenes = () => Array.from({ length: c.n }, () => Keypair.generate());

          // Vault A — no plan; holds SOL + a token (for withdraw_from_vault frozen).
          const ownerA = Keypair.generate(), agentA = Keypair.generate();
          const pA = await initVault(svm, ownerA, agentA, mkBenes(), c.shares, 100_000_000n);
          const { mint, vaultAta } = fundVaultToken(svm, ownerA, pA.vault, 0, 1000n);
          const { ata: ownerAta, ix: oAtaIx } = createAtaIx(ownerA.publicKey, ownerA.publicKey, mint);
          send(svm, new Transaction().add(oAtaIx), ownerA);

          // Vault B — has a plan (created pre-deadline) → update_asset_plan frozen.
          const ownerB = Keypair.generate(), agentB = Keypair.generate();
          const pB = await initVault(svm, ownerB, agentB, mkBenes(), c.shares, 50_000_000n);
          send(svm, await txSetPlan(ownerB, pB), ownerB);

          // Vault C — SOL; proves the exact `>=` boundary via withdraw_sol.
          const ownerC = Keypair.generate(), agentC = Keypair.generate();
          const pC = await initVault(svm, ownerC, agentC, mkBenes(), c.shares, 100_000_000n);

          // Vault D — SOL; proves pre-deadline heartbeat + rotate SUCCEED (not always-frozen).
          const ownerD = Keypair.generate(), agentD = Keypair.generate();
          const pD = await initVault(svm, ownerD, agentD, mkBenes(), c.shares, 50_000_000n);

          // all four pinned to the same deadline
          expect(readI64LE(svm, pA.heartbeat, OFF_HEARTBEAT_LAST)).to.equal(BASE);
          expect(readI64LE(svm, pC.heartbeat, OFF_HEARTBEAT_LAST)).to.equal(BASE);

          // --- PRE-deadline (D0 - 1): representative mutations SUCCEED --------------
          warpClockTo(svm, D0 - 1n);
          const cBefore = bal(svm, pC.vault);
          send(svm, await txWithdrawSol(ownerC, pC, 1000), ownerC);
          expect(bal(svm, pC.vault) < cBefore, "withdraw_sol executed pre-deadline").to.equal(true);
          send(svm, await txHeartbeat(agentD, pD), ownerD, [agentD]); // agent signs
          send(svm, await txRotate(ownerD, pD, Keypair.generate().publicKey), ownerD);

          // --- EXACT boundary (now == D0): the same withdraw is now FROZEN ---------
          warpClockTo(svm, D0);
          await expectBadTx(svm, txWithdrawSol(ownerC, pC, 1000), ownerC, [], VF);

          // --- POST-deadline (D0 + delta): the full frozen battery -----------------
          warpClockTo(svm, D0 + BigInt(c.delta));
          await expectBadTx(svm, txUpdate(ownerA, pA), ownerA, [], VF);
          await expectBadTx(svm, txWithdrawSol(ownerA, pA, 1000), ownerA, [], VF);
          await expectBadTx(svm, txWithdrawTok(ownerA, pA, mint, vaultAta, ownerAta), ownerA, [], VF);
          await expectBadTx(svm, txRotate(ownerA, pA, Keypair.generate().publicKey), ownerA, [], VF);
          await expectBadTx(svm, txHeartbeat(agentA, pA), ownerA, [agentA], VF);
          await expectBadTx(svm, txSetPlan(ownerA, pA), ownerA, [], API);
          // revoke last — it would close the vault if it (wrongly) succeeded.
          await expectBadTx(svm, txRevoke(ownerA, pA), ownerA, [], VF);
          // Vault B: update_asset_plan on an existing plan → AssetPlanImmutable.
          await expectBadTx(svm, txUpdatePlan(ownerB, pB), ownerB, [], API);
          // Vault B: clear_asset_plan post-deadline (has a plan) → VaultFrozen.
          await expectBadTx(svm, txClearPlan(ownerB, pB), ownerB, [], VF);
        })
      ),
      { numRuns: 12, endOnFailure: true }
    );
  });
});
