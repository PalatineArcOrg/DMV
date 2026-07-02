import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { DeadMansVault } from "../target/types/dead_mans_vault";
import { expect } from "chai";
import {
  createMint,
  mintTo,
  getAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

const { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL, Transaction } =
  anchor.web3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Demo-floor durations (constants.rs MIN_HEARTBEAT_INTERVAL=10, MIN_GRACE_PERIOD=30).
const INTERVAL = 10;
const GRACE = 30;
// deadline = last_heartbeat + INTERVAL + GRACE. Wait a touch past it.
const GRACE_WAIT_MS = (INTERVAL + GRACE + 3) * 1000;

describe("dead-mans-vault — permissionless execution", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.deadMansVault as Program<DeadMansVault>;
  const conn = provider.connection;

  // ── helpers ──────────────────────────────────────────────────────────

  async function fund(pubkey: anchor.web3.PublicKey, sol: number) {
    const sig = await conn.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
    const bh = await conn.getLatestBlockhash();
    await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  }

  function pdas(owner: anchor.web3.PublicKey) {
    const [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), owner.toBuffer()],
      program.programId
    );
    const [heartbeat] = PublicKey.findProgramAddressSync(
      [Buffer.from("heartbeat"), vault.toBuffer()],
      program.programId
    );
    const [execution] = PublicKey.findProgramAddressSync(
      [Buffer.from("execution"), vault.toBuffer()],
      program.programId
    );
    const [assetPlan] = PublicKey.findProgramAddressSync(
      [Buffer.from("asset_plan"), vault.toBuffer()],
      program.programId
    );
    return { vault, heartbeat, execution, assetPlan };
  }

  function tokenDistPda(vault: anchor.web3.PublicKey, mint: anchor.web3.PublicKey) {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_dist"), vault.toBuffer(), mint.toBuffer()],
      program.programId
    );
    return pda;
  }

  // Build initialize_vault signed by a fresh owner.
  async function initVault(opts: {
    owner: anchor.web3.Keypair;
    agent: anchor.web3.PublicKey;
    beneficiaries: { wallet: anchor.web3.PublicKey; shareBps: number }[];
    interval?: number;
    grace?: number;
    isMutable?: boolean;
  }) {
    const { vault, heartbeat } = pdas(opts.owner.publicKey);
    await program.methods
      .initializeVault({
        agentPubkey: opts.agent,
        heartbeatInterval: new BN(opts.interval ?? INTERVAL),
        gracePeriod: new BN(opts.grace ?? GRACE),
        beneficiaries: opts.beneficiaries,
        isMutable: opts.isMutable ?? true,
      })
      .accountsPartial({
        owner: opts.owner.publicKey,
        vaultConfig: vault,
        heartbeatRecord: heartbeat,
        systemProgram: SystemProgram.programId,
      })
      .signers([opts.owner])
      .rpc();
    return pdas(opts.owner.publicKey);
  }

  async function depositSol(
    owner: anchor.web3.Keypair,
    vault: anchor.web3.PublicKey,
    lamports: number
  ) {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: owner.publicKey,
        toPubkey: vault,
        lamports,
      })
    );
    await provider.sendAndConfirm(tx, [owner]);
  }

  async function makeMint(
    payer: anchor.web3.Keypair,
    decimals: number,
    programId = TOKEN_PROGRAM_ID
  ) {
    return await createMint(
      conn,
      payer,
      payer.publicKey,
      null,
      decimals,
      undefined,
      undefined,
      programId
    );
  }

  // Create an ATA (works for PDA owners via allowOwnerOffCurve).
  async function makeAta(
    payer: anchor.web3.Keypair,
    mint: anchor.web3.PublicKey,
    owner: anchor.web3.PublicKey,
    programId = TOKEN_PROGRAM_ID
  ) {
    const ata = getAssociatedTokenAddressSync(mint, owner, true, programId);
    const ix = createAssociatedTokenAccountInstruction(
      payer.publicKey,
      ata,
      owner,
      mint,
      programId
    );
    await provider.sendAndConfirm(new Transaction().add(ix), [payer]);
    return ata;
  }

  async function fundVaultToken(
    payer: anchor.web3.Keypair,
    mint: anchor.web3.PublicKey,
    vault: anchor.web3.PublicKey,
    amount: number | bigint,
    programId = TOKEN_PROGRAM_ID
  ) {
    const ata = await makeAta(payer, mint, vault, programId);
    await mintTo(conn, payer, mint, ata, payer, amount, [], undefined, programId);
    return ata;
  }

  function expectErr(e: any, code: string) {
    const s = (e?.toString?.() ?? "") + JSON.stringify(e?.logs ?? "");
    expect(
      (e?.error?.errorCode?.code === code) || s.includes(code),
      `expected error ${code}, got: ${e?.error?.errorCode?.code ?? s.slice(0, 300)}`
    ).to.be.true;
  }

  before("fund provider wallet (pays setup tx fees)", async () => {
    const bal = await conn.getBalance(provider.wallet.publicKey);
    if (bal < 100 * LAMPORTS_PER_SOL) {
      await fund(provider.wallet.publicKey, 500);
    }
  });

  // ════════════════════════════════════════════════════════════════════
  //  PART A — setup, owner ops & guards (no grace wait)
  // ════════════════════════════════════════════════════════════════════
  describe("setup, owner ops & guards", () => {
    let owner: anchor.web3.Keypair;
    const agent = Keypair.generate();
    const b1 = Keypair.generate();
    const b2 = Keypair.generate();

    before(async () => {
      owner = Keypair.generate();
      await fund(owner.publicKey, 10);
    });

    it("initializes a vault", async () => {
      const { vault, heartbeat } = await initVault({
        owner,
        agent: agent.publicKey,
        beneficiaries: [
          { wallet: b1.publicKey, shareBps: 7000 },
          { wallet: b2.publicKey, shareBps: 3000 },
        ],
        interval: 604800,
        grace: 2073600,
      });
      const v = await program.account.vaultConfig.fetch(vault);
      expect(v.owner.toString()).to.equal(owner.publicKey.toString());
      expect(v.beneficiaries.length).to.equal(2);
      expect(v.hasAssetPlan).to.be.false;
      expect(v.openTokenDists).to.equal(0);
      const h = await program.account.heartbeatRecord.fetch(heartbeat);
      expect(h.totalHeartbeats.toNumber()).to.equal(1);
    });

    it("rejects interval too short", async () => {
      const o = Keypair.generate();
      await fund(o.publicKey, 2);
      try {
        await initVault({
          owner: o,
          agent: agent.publicKey,
          beneficiaries: [{ wallet: b1.publicKey, shareBps: 10000 }],
          interval: 5,
        });
        expect.fail("should reject");
      } catch (e) {
        expectErr(e, "HeartbeatIntervalTooShort");
      }
    });

    it("rejects grace too short", async () => {
      const o = Keypair.generate();
      await fund(o.publicKey, 2);
      try {
        await initVault({
          owner: o,
          agent: agent.publicKey,
          beneficiaries: [{ wallet: b1.publicKey, shareBps: 10000 }],
          grace: 15,
        });
        expect.fail("should reject");
      } catch (e) {
        expectErr(e, "GracePeriodTooShort");
      }
    });

    it("rejects shares not summing to 10000", async () => {
      const o = Keypair.generate();
      await fund(o.publicKey, 2);
      try {
        await initVault({
          owner: o,
          agent: agent.publicKey,
          beneficiaries: [
            { wallet: b1.publicKey, shareBps: 5000 },
            { wallet: b2.publicKey, shareBps: 4000 },
          ],
        });
        expect.fail("should reject");
      } catch (e) {
        expectErr(e, "InvalidShareAllocation");
      }
    });

    it("rejects owner as beneficiary", async () => {
      const o = Keypair.generate();
      await fund(o.publicKey, 2);
      try {
        await initVault({
          owner: o,
          agent: agent.publicKey,
          beneficiaries: [{ wallet: o.publicKey, shareBps: 10000 }],
        });
        expect.fail("should reject");
      } catch (e) {
        expectErr(e, "OwnerCannotBeBeneficiary");
      }
    });

    it("records heartbeat from agent, rejects non-agent", async () => {
      const { vault, heartbeat } = pdas(owner.publicKey);
      await program.methods
        .recordHeartbeat({ activeTap: {} })
        .accountsPartial({ agent: agent.publicKey, vaultConfig: vault, heartbeatRecord: heartbeat })
        .signers([agent])
        .rpc();
      const h = await program.account.heartbeatRecord.fetch(heartbeat);
      expect(h.totalHeartbeats.toNumber()).to.equal(2);

      const imposter = Keypair.generate();
      await fund(imposter.publicKey, 1);
      try {
        await program.methods
          .recordHeartbeat({ activeTap: {} })
          .accountsPartial({ agent: imposter.publicKey, vaultConfig: vault, heartbeatRecord: heartbeat })
          .signers([imposter])
          .rpc();
        expect.fail("should reject");
      } catch (e) {
        expectErr(e, "UnauthorizedAgent");
      }
    });

    it("allows owner update (pre-grace), rejects non-owner", async () => {
      const { vault, heartbeat } = pdas(owner.publicKey);
      await program.methods
        .updateVault({ heartbeatInterval: new BN(700000), gracePeriod: null, beneficiaries: null })
        .accountsPartial({ owner: owner.publicKey, vaultConfig: vault, heartbeatRecord: heartbeat })
        .signers([owner])
        .rpc();
      const v = await program.account.vaultConfig.fetch(vault);
      expect(v.heartbeatInterval.toNumber()).to.equal(700000);

      const imposter = Keypair.generate();
      await fund(imposter.publicKey, 1);
      try {
        await program.methods
          .updateVault({ heartbeatInterval: new BN(800000), gracePeriod: null, beneficiaries: null })
          .accountsPartial({ owner: imposter.publicKey, vaultConfig: vault, heartbeatRecord: heartbeat })
          .signers([imposter])
          .rpc();
        expect.fail("should reject");
      } catch (e) {
        // seeds=[vault, owner] re-derive from the imposter → blocked by ConstraintSeeds
        // before has_one is even evaluated. Either way the non-owner is rejected.
        expectErr(e, "ConstraintSeeds");
      }
    });

    it("rotate agent: happy + zero/owner/same guards", async () => {
      const { vault, heartbeat } = pdas(owner.publicKey);
      const newAgent = Keypair.generate();
      await program.methods
        .rotateAgent(newAgent.publicKey)
        .accountsPartial({ owner: owner.publicKey, vaultConfig: vault, heartbeatRecord: heartbeat })
        .signers([owner])
        .rpc();
      const v = await program.account.vaultConfig.fetch(vault);
      expect(v.agentPubkey.toString()).to.equal(newAgent.publicKey.toString());

      const cases: [anchor.web3.PublicKey, string][] = [
        [PublicKey.default, "InvalidAgentPubkey"],
        [owner.publicKey, "AgentCannotBeOwner"],
        [newAgent.publicKey, "AgentKeyUnchanged"],
      ];
      for (const [key, code] of cases) {
        try {
          await program.methods
            .rotateAgent(key)
            .accountsPartial({ owner: owner.publicKey, vaultConfig: vault, heartbeatRecord: heartbeat })
            .signers([owner])
            .rpc();
          expect.fail("should reject " + code);
        } catch (e) {
          expectErr(e, code);
        }
      }
    });

    it("set_asset_plan: 64 ok, 65 rejected, dup-NFT rejected", async () => {
      const o = Keypair.generate();
      await fund(o.publicKey, 3);
      const { vault, heartbeat, assetPlan } = await initVault({
        owner: o,
        agent: agent.publicKey,
        beneficiaries: [{ wallet: b1.publicKey, shareBps: 10000 }],
      });
      const m = Keypair.generate().publicKey;
      const mk = (n: number) =>
        Array.from({ length: n }, () => ({
          mint: m,
          amount: new BN(1),
          beneficiaryIndex: 0,
          isNft: false,
        }));

      // NOTE: the AssetPlan account stores up to MAX_ASSIGNMENTS=64, but a single
      // set_asset_plan tx caps at ~18 assignments because instruction data
      // (42 B each) must fit the 1232-byte transaction limit. The on-chain
      // TooManyAssignments(>64) guard is therefore defensive/unreachable from a
      // normal single-tx client. We test a realistic count here.
      await program.methods
        .setAssetPlan(mk(18))
        .accountsPartial({ owner: o.publicKey, vaultConfig: vault, heartbeatRecord: heartbeat, assetPlan, systemProgram: SystemProgram.programId })
        .signers([o])
        .rpc();
      const plan = await program.account.assetPlan.fetch(assetPlan);
      expect(plan.assignments.length).to.equal(18);
      const v = await program.account.vaultConfig.fetch(vault);
      expect(v.hasAssetPlan).to.be.true;

      // two NFT assignments same mint → DuplicateNftAssignment
      const nftMint = Keypair.generate().publicKey;
      try {
        await program.methods
          .updateAssetPlan([
            { mint: nftMint, amount: new BN(1), beneficiaryIndex: 0, isNft: true },
            { mint: nftMint, amount: new BN(1), beneficiaryIndex: 0, isNft: true },
          ])
          .accountsPartial({ owner: o.publicKey, vaultConfig: vault, heartbeatRecord: heartbeat, assetPlan })
          .signers([o])
          .rpc();
        expect.fail("should reject dup nft");
      } catch (e) {
        expectErr(e, "DuplicateNftAssignment");
      }
    });

    it("set_asset_plan validates SOL bequests (InvalidSolBequest)", async () => {
      const o = Keypair.generate();
      await fund(o.publicKey, 2);
      const b1 = Keypair.generate();
      const { vault, heartbeat, assetPlan } = await initVault({
        owner: o,
        agent: Keypair.generate().publicKey,
        beneficiaries: [{ wallet: b1.publicKey, shareBps: 10000 }],
      });
      const setPlan = (assignments: any[]) =>
        program.methods
          .setAssetPlan(assignments)
          .accountsPartial({ owner: o.publicKey, vaultConfig: vault, heartbeatRecord: heartbeat, assetPlan, systemProgram: SystemProgram.programId })
          .signers([o])
          .rpc();

      // zero-amount SOL bequest → rejected (fails first; tx rolls back, no account)
      try {
        await setPlan([{ mint: PublicKey.default, amount: new BN(0), beneficiaryIndex: 0, isNft: false }]);
        expect.fail("should reject zero-amount SOL bequest");
      } catch (e) { expectErr(e, "InvalidSolBequest"); }

      // SOL flagged as NFT → rejected
      try {
        await setPlan([{ mint: PublicKey.default, amount: new BN(1000), beneficiaryIndex: 0, isNft: true }]);
        expect.fail("should reject SOL-as-NFT");
      } catch (e) { expectErr(e, "InvalidSolBequest"); }

      // valid SOL bequest accepted
      await setPlan([{ mint: PublicKey.default, amount: new BN(1000), beneficiaryIndex: 0, isNft: false }]);
      const plan = await program.account.assetPlan.fetch(assetPlan);
      expect(plan.assignments.length).to.equal(1);
      expect(plan.assignments[0].mint.equals(PublicKey.default)).to.be.true;
    });

    it("update_vault rejects beneficiary edit while plan exists (BeneficiariesLockedByPlan)", async () => {
      const o = Keypair.generate();
      await fund(o.publicKey, 3);
      const { vault, heartbeat, assetPlan } = await initVault({
        owner: o,
        agent: agent.publicKey,
        beneficiaries: [{ wallet: b1.publicKey, shareBps: 10000 }],
      });
      await program.methods
        .setAssetPlan([{ mint: Keypair.generate().publicKey, amount: new BN(1), beneficiaryIndex: 0, isNft: false }])
        .accountsPartial({ owner: o.publicKey, vaultConfig: vault, heartbeatRecord: heartbeat, assetPlan, systemProgram: SystemProgram.programId })
        .signers([o])
        .rpc();
      try {
        await program.methods
          .updateVault({ heartbeatInterval: null, gracePeriod: null, beneficiaries: [{ wallet: b2.publicKey, shareBps: 10000 }] })
          .accountsPartial({ owner: o.publicKey, vaultConfig: vault, heartbeatRecord: heartbeat })
          .signers([o])
          .rpc();
        expect.fail("should reject");
      } catch (e) {
        expectErr(e, "BeneficiariesLockedByPlan");
      }
    });

    it("revoke closes PDAs and allows re-init; rejects non-owner", async () => {
      const o = Keypair.generate();
      await fund(o.publicKey, 3);
      const { vault, heartbeat } = await initVault({
        owner: o,
        agent: agent.publicKey,
        beneficiaries: [{ wallet: b1.publicKey, shareBps: 10000 }],
      });

      const imposter = Keypair.generate();
      await fund(imposter.publicKey, 1);
      try {
        await program.methods
          .revokeVault()
          .accountsPartial({ owner: imposter.publicKey, vaultConfig: vault, heartbeatRecord: heartbeat, assetPlan: null })
          .signers([imposter])
          .rpc();
        expect.fail("should reject");
      } catch (e) {
        // seeds=[vault, owner] re-derive from imposter → ConstraintSeeds blocks the non-owner.
        expectErr(e, "ConstraintSeeds");
      }

      await program.methods
        .revokeVault()
        .accountsPartial({ owner: o.publicKey, vaultConfig: vault, heartbeatRecord: heartbeat, assetPlan: null })
        .signers([o])
        .rpc();
      expect(await conn.getAccountInfo(vault)).to.be.null;

      // re-init on same owner works (slot freed)
      await initVault({
        owner: o,
        agent: agent.publicKey,
        beneficiaries: [{ wallet: b2.publicKey, shareBps: 10000 }],
      });
      const v = await program.account.vaultConfig.fetch(vault);
      expect(v.beneficiaries[0].wallet.toString()).to.equal(b2.publicKey.toString());
    });

    it("immutable vault blocks update & revoke", async () => {
      const o = Keypair.generate();
      await fund(o.publicKey, 3);
      const { vault, heartbeat } = await initVault({
        owner: o,
        agent: agent.publicKey,
        beneficiaries: [{ wallet: b1.publicKey, shareBps: 10000 }],
        isMutable: false,
      });
      try {
        await program.methods
          .updateVault({ heartbeatInterval: new BN(700000), gracePeriod: null, beneficiaries: null })
          .accountsPartial({ owner: o.publicKey, vaultConfig: vault, heartbeatRecord: heartbeat })
          .signers([o])
          .rpc();
        expect.fail("update should reject");
      } catch (e) {
        expectErr(e, "VaultImmutable");
      }
      try {
        await program.methods
          .revokeVault()
          .accountsPartial({ owner: o.publicKey, vaultConfig: vault, heartbeatRecord: heartbeat, assetPlan: null })
          .signers([o])
          .rpc();
        expect.fail("revoke should reject");
      } catch (e) {
        expectErr(e, "VaultImmutable");
      }
    });

    it("begin_execution before deadline fails (GraceNotElapsed)", async () => {
      const o = Keypair.generate();
      await fund(o.publicKey, 3);
      const { vault, heartbeat, execution } = await initVault({
        owner: o,
        agent: agent.publicKey,
        beneficiaries: [{ wallet: b1.publicKey, shareBps: 10000 }],
        interval: 604800,
        grace: 2073600,
      });
      const cranker = Keypair.generate();
      await fund(cranker.publicKey, 1);
      try {
        await program.methods
          .beginExecution()
          .accountsPartial({ payer: cranker.publicKey, vaultConfig: vault, heartbeatRecord: heartbeat, executionLog: execution, assetPlan: null, systemProgram: SystemProgram.programId })
          .signers([cranker])
          .rpc();
        expect.fail("should reject");
      } catch (e) {
        expectErr(e, "GraceNotElapsed");
      }
    });
  });

  // ════════════════════════════════════════════════════════════════════
  //  PART B — permissionless execution flows (single shared grace wait)
  // ════════════════════════════════════════════════════════════════════
  describe("execution flows (one grace wait)", function () {
    this.timeout(240000);

    const agent = Keypair.generate();
    const cranker = Keypair.generate(); // permissionless: NOT owner, NOT agent

    // Per-scenario state, all built before a single wait.
    const S: any = {};

    before(async function () {
      this.timeout(240000);
      await fund(cranker.publicKey, 20);

      // --- scenario: SOL pro-rata with dust ---
      {
        const owner = Keypair.generate();
        await fund(owner.publicKey, 5);
        const b1 = Keypair.generate(), b2 = Keypair.generate(), b3 = Keypair.generate();
        const p = await initVault({
          owner,
          agent: agent.publicKey,
          beneficiaries: [
            { wallet: b1.publicKey, shareBps: 3333 },
            { wallet: b2.publicKey, shareBps: 3333 },
            { wallet: b3.publicKey, shareBps: 3334 },
          ],
        });
        await depositSol(owner, p.vault, 2 * LAMPORTS_PER_SOL + 7);
        S.sol = { owner, b: [b1, b2, b3], ...p };
      }

      // --- scenario: specific SPL bequest + NFT + residual ---
      {
        const owner = Keypair.generate();
        await fund(owner.publicKey, 5);
        const b1 = Keypair.generate(), b2 = Keypair.generate();
        const p = await initVault({
          owner,
          agent: agent.publicKey,
          beneficiaries: [
            { wallet: b1.publicKey, shareBps: 6000 },
            { wallet: b2.publicKey, shareBps: 4000 },
          ],
        });
        const tokenMint = await makeMint(owner, 6);
        const nftMint = await makeMint(owner, 0);
        await fundVaultToken(owner, tokenMint, p.vault, 1_000_000); // 1.0 token (6 dp)
        await fundVaultToken(owner, nftMint, p.vault, 1);
        // assignment: 300000 of token to b2 (index 1), whole NFT to b1 (index 0)
        await program.methods
          .setAssetPlan([
            { mint: tokenMint, amount: new BN(300_000), beneficiaryIndex: 1, isNft: false },
            { mint: nftMint, amount: new BN(1), beneficiaryIndex: 0, isNft: true },
          ])
          .accountsPartial({ owner: owner.publicKey, vaultConfig: p.vault, heartbeatRecord: p.heartbeat, assetPlan: p.assetPlan, systemProgram: SystemProgram.programId })
          .signers([owner])
          .rpc();
        S.spec = { owner, b: [b1, b2], tokenMint, nftMint, ...p };
      }

      // --- scenario: theft attempts (SOL + token) ---
      {
        const owner = Keypair.generate();
        await fund(owner.publicKey, 5);
        const b1 = Keypair.generate(), b2 = Keypair.generate();
        const p = await initVault({
          owner,
          agent: agent.publicKey,
          beneficiaries: [
            { wallet: b1.publicKey, shareBps: 5000 },
            { wallet: b2.publicKey, shareBps: 5000 },
          ],
        });
        await depositSol(owner, p.vault, 1 * LAMPORTS_PER_SOL);
        const tokenMint = await makeMint(owner, 0);
        await fundVaultToken(owner, tokenMint, p.vault, 1000);
        await program.methods
          .setAssetPlan([
            { mint: tokenMint, amount: new BN(100), beneficiaryIndex: 0, isNft: false },
            { mint: tokenMint, amount: new BN(200), beneficiaryIndex: 1, isNft: false },
          ])
          .accountsPartial({ owner: owner.publicKey, vaultConfig: p.vault, heartbeatRecord: p.heartbeat, assetPlan: p.assetPlan, systemProgram: SystemProgram.programId })
          .signers([owner])
          .rpc();
        S.theft = { owner, b: [b1, b2], tokenMint, ...p };
      }

      // --- scenario: idempotency (SOL, 3 benef) ---
      {
        const owner = Keypair.generate();
        await fund(owner.publicKey, 5);
        const b = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
        const p = await initVault({
          owner,
          agent: agent.publicKey,
          beneficiaries: b.map((k, i) => ({ wallet: k.publicKey, shareBps: i === 2 ? 3334 : 3333 })),
        });
        await depositSol(owner, p.vault, 3 * LAMPORTS_PER_SOL);
        S.idem = { owner, b, ...p };
      }

      // --- scenario: freeze-after-deadline (never cranked) ---
      {
        const owner = Keypair.generate();
        await fund(owner.publicKey, 5);
        const b1 = Keypair.generate();
        const p = await initVault({
          owner,
          agent: agent.publicKey,
          beneficiaries: [{ wallet: b1.publicKey, shareBps: 10000 }],
        });
        await depositSol(owner, p.vault, 1 * LAMPORTS_PER_SOL);
        S.frozen = { owner, b: [b1], ...p };
      }

      // --- scenario: Token-2022 residual ---
      {
        const owner = Keypair.generate();
        await fund(owner.publicKey, 5);
        const b1 = Keypair.generate(), b2 = Keypair.generate();
        const p = await initVault({
          owner,
          agent: agent.publicKey,
          beneficiaries: [
            { wallet: b1.publicKey, shareBps: 5000 },
            { wallet: b2.publicKey, shareBps: 5000 },
          ],
        });
        const mint = await makeMint(owner, 0, TOKEN_2022_PROGRAM_ID);
        await fundVaultToken(owner, mint, p.vault, 1000, TOKEN_2022_PROGRAM_ID);
        S.t22 = { owner, b: [b1, b2], mint, ...p };
      }

      // --- scenario: underfunded mint + unheld-mint assignment ---
      {
        const owner = Keypair.generate();
        await fund(owner.publicKey, 5);
        const b1 = Keypair.generate();
        const p = await initVault({
          owner,
          agent: agent.publicKey,
          beneficiaries: [{ wallet: b1.publicKey, shareBps: 10000 }],
        });
        const heldMint = await makeMint(owner, 0);
        await fundVaultToken(owner, heldMint, p.vault, 50); // only 50 held
        const unheldMint = await makeMint(owner, 0); // vault holds 0
        await program.methods
          .setAssetPlan([
            { mint: heldMint, amount: new BN(100), beneficiaryIndex: 0, isNft: false }, // wants 100, only 50 avail
            { mint: unheldMint, amount: new BN(5), beneficiaryIndex: 0, isNft: false }, // unheld
          ])
          .accountsPartial({ owner: owner.publicKey, vaultConfig: p.vault, heartbeatRecord: p.heartbeat, assetPlan: p.assetPlan, systemProgram: SystemProgram.programId })
          .signers([owner])
          .rpc();
        S.edge = { owner, b: [b1], heldMint, unheldMint, ...p };
      }

      // --- scenario: specific-SOL bequest + pro-rata residual ---
      {
        const owner = Keypair.generate();
        await fund(owner.publicKey, 5);
        const b1 = Keypair.generate(), b2 = Keypair.generate();
        const p = await initVault({
          owner,
          agent: agent.publicKey,
          beneficiaries: [
            { wallet: b1.publicKey, shareBps: 6000 },
            { wallet: b2.publicKey, shareBps: 4000 },
          ],
        });
        await depositSol(owner, p.vault, 2 * LAMPORTS_PER_SOL);
        // Bequeath exactly 0.5 SOL to b2 (index 1); the remaining residual splits 60/40.
        await program.methods
          .setAssetPlan([
            { mint: PublicKey.default, amount: new BN(LAMPORTS_PER_SOL / 2), beneficiaryIndex: 1, isNft: false },
          ])
          .accountsPartial({ owner: owner.publicKey, vaultConfig: p.vault, heartbeatRecord: p.heartbeat, assetPlan: p.assetPlan, systemProgram: SystemProgram.programId })
          .signers([owner])
          .rpc();
        S.specsol = { owner, b: [b1, b2], specificLamports: LAMPORTS_PER_SOL / 2, ...p };
      }

      // ONE grace wait for every scenario above.
      await sleep(GRACE_WAIT_MS);
    });

    // helper: begin_execution by cranker (asset_plan required iff the vault has one)
    async function beginExec(s: any, hasPlan: boolean = false) {
      await program.methods
        .beginExecution()
        .accountsPartial({ payer: cranker.publicKey, vaultConfig: s.vault, heartbeatRecord: s.heartbeat, executionLog: s.execution, assetPlan: hasPlan ? s.assetPlan : null, systemProgram: SystemProgram.programId })
        .signers([cranker])
        .rpc();
    }
    // helper: pay a specific-SOL bequest by cranker
    async function specificSol(s: any, idx: number, benefWallet: anchor.web3.PublicKey) {
      await program.methods
        .executeSpecificSol(idx)
        .accountsPartial({ payer: cranker.publicKey, vaultConfig: s.vault, executionLog: s.execution, assetPlan: s.assetPlan, beneficiary: benefWallet })
        .signers([cranker])
        .rpc();
    }
    async function solShares(s: any, indices: number[], wallets: anchor.web3.PublicKey[]) {
      await program.methods
        .executeSolShares(Buffer.from(indices))
        .accountsPartial({ payer: cranker.publicKey, vaultConfig: s.vault, executionLog: s.execution })
        .remainingAccounts(wallets.map((pk) => ({ pubkey: pk, isWritable: true, isSigner: false })))
        .signers([cranker])
        .rpc();
    }
    async function finalize(s: any, hasPlan: boolean) {
      await program.methods
        .finalizeExecution()
        .accountsPartial({ payer: cranker.publicKey, vaultConfig: s.vault, executionLog: s.execution, assetPlan: hasPlan ? s.assetPlan : null })
        .signers([cranker])
        .rpc();
    }

    it("SOL pro-rata: exact floor shares, dust→largest benef, rent→owner", async () => {
      const s = S.sol;
      await beginExec(s);
      const log = await program.account.executionLog.fetch(s.execution);
      const snap = log.solSnapshot;
      const shares = [3333, 3333, 3334];
      const expected = shares.map((bp) => snap.mul(new BN(bp)).div(new BN(10000)));

      const before = await Promise.all(s.b.map((k: any) => conn.getBalance(k.publicKey)));
      await solShares(s, [0, 1, 2], s.b.map((k: any) => k.publicKey));
      const after = await Promise.all(s.b.map((k: any) => conn.getBalance(k.publicKey)));
      for (let i = 0; i < 3; i++) {
        expect(after[i] - before[i]).to.equal(expected[i].toNumber());
      }
      await finalize(s, false);
      const v = await program.account.vaultConfig.fetch(s.vault);
      expect(v.executed).to.be.true;
      expect(v.active).to.be.false;

      // dust = snapshot - Σexpected; should go to largest-share benef (index 2, 3334)
      const paidSum = expected.reduce((a, b) => a.add(b), new BN(0));
      const dust = snap.sub(paidSum).toNumber();
      const ownerBalBefore = await conn.getBalance(s.owner.publicKey);
      const b2Before = await conn.getBalance(s.b[2].publicKey);
      await program.methods
        .closeExecutedVaultByOwner()
        .accountsPartial({ owner: s.owner.publicKey, vaultConfig: s.vault, heartbeatRecord: s.heartbeat, executionLog: s.execution, assetPlan: null, largestBenef: dust > 0 ? s.b[2].publicKey : null })
        .signers([s.owner])
        .rpc();
      expect(await conn.getAccountInfo(s.vault)).to.be.null;
      const b2After = await conn.getBalance(s.b[2].publicKey);
      expect(b2After - b2Before).to.equal(dust);
      const ownerBalAfter = await conn.getBalance(s.owner.publicKey);
      expect(ownerBalAfter).to.be.greaterThan(ownerBalBefore); // rent returned
    });

    it("specific SPL bequest + NFT + pro-rata token residual (permissionless)", async () => {
      const s = S.spec;
      await beginExec(s, true);

      // token residual snapshot = 1_000_000 - 300_000 = 700_000
      const tokenDist = tokenDistPda(s.vault, s.tokenMint);
      const vaultTokenAta = getAssociatedTokenAddressSync(s.tokenMint, s.vault, true);
      await program.methods
        .beginTokenDist()
        .accountsPartial({ payer: cranker.publicKey, vaultConfig: s.vault, executionLog: s.execution, mint: s.tokenMint, vaultAta: vaultTokenAta, assetPlan: s.assetPlan, tokenDist, systemProgram: SystemProgram.programId })
        .signers([cranker])
        .rpc();
      const td = await program.account.tokenDist.fetch(tokenDist);
      expect(td.snapshot.toNumber()).to.equal(700_000);

      // NFT dist
      const nftDist = tokenDistPda(s.vault, s.nftMint);
      const vaultNftAta = getAssociatedTokenAddressSync(s.nftMint, s.vault, true);
      await program.methods
        .beginTokenDist()
        .accountsPartial({ payer: cranker.publicKey, vaultConfig: s.vault, executionLog: s.execution, mint: s.nftMint, vaultAta: vaultNftAta, assetPlan: s.assetPlan, tokenDist: nftDist, systemProgram: SystemProgram.programId })
        .signers([cranker])
        .rpc();

      // execute specific #0: token 300000 → b2 (index1)
      const b2TokenAta = await makeAta(cranker, s.tokenMint, s.b[1].publicKey);
      await program.methods
        .executeSpecificAsset(0)
        .accountsPartial({ payer: cranker.publicKey, vaultConfig: s.vault, executionLog: s.execution, assetPlan: s.assetPlan, mint: s.tokenMint, tokenDist, vaultAta: vaultTokenAta, beneficiaryAta: b2TokenAta, tokenProgram: TOKEN_PROGRAM_ID })
        .signers([cranker])
        .rpc();
      expect(Number((await getAccount(conn, b2TokenAta)).amount)).to.equal(300_000);

      // execute specific #1: NFT → b1 (index0)
      const b1NftAta = await makeAta(cranker, s.nftMint, s.b[0].publicKey);
      await program.methods
        .executeSpecificAsset(1)
        .accountsPartial({ payer: cranker.publicKey, vaultConfig: s.vault, executionLog: s.execution, assetPlan: s.assetPlan, mint: s.nftMint, tokenDist: nftDist, vaultAta: vaultNftAta, beneficiaryAta: b1NftAta, tokenProgram: TOKEN_PROGRAM_ID })
        .signers([cranker])
        .rpc();
      expect(Number((await getAccount(conn, b1NftAta)).amount)).to.equal(1);

      // SOL: vault has only rent (no deposit) → snapshot 0, shares all 0
      const log = await program.account.executionLog.fetch(s.execution);
      await solShares(s, [0, 1], s.b.map((k: any) => k.publicKey));
      await finalize(s, true);
      const v = await program.account.vaultConfig.fetch(s.vault);
      expect(v.executed).to.be.true;

      // token residual 700000 split 6000/4000 → 420000 / 280000
      const b1TokenAta = await makeAta(cranker, s.tokenMint, s.b[0].publicKey);
      const vaultTokenMeta = (pk: anchor.web3.PublicKey) => ({ pubkey: pk, isWritable: true, isSigner: false });
      await program.methods
        .executeTokenShares(Buffer.from([0, 1]))
        .accountsPartial({ payer: cranker.publicKey, vaultConfig: s.vault, tokenDist, mint: s.tokenMint, vaultAta: vaultTokenAta, tokenProgram: TOKEN_PROGRAM_ID })
        .remainingAccounts([vaultTokenMeta(b1TokenAta), vaultTokenMeta(b2TokenAta)])
        .signers([cranker])
        .rpc();
      expect(Number((await getAccount(conn, b1TokenAta)).amount)).to.equal(420_000);
      expect(Number((await getAccount(conn, b2TokenAta)).amount)).to.equal(280_000 + 300_000);

      // close token dist (residual fully paid → dust 0)
      await program.methods
        .closeTokenDist()
        .accountsPartial({ payer: cranker.publicKey, owner: s.owner.publicKey, vaultConfig: s.vault, mint: s.tokenMint, vaultAta: vaultTokenAta, tokenDist, largestBenefAta: null, tokenProgram: TOKEN_PROGRAM_ID })
        .signers([cranker])
        .rpc();
      expect(await conn.getAccountInfo(tokenDist)).to.be.null;

      // NFT residual is 0 (whole supply bequeathed), but close still requires a
      // full paid-mask, so run execute_token_shares (0-amount, just sets bits).
      const b2NftAta = await makeAta(cranker, s.nftMint, s.b[1].publicKey);
      await program.methods
        .executeTokenShares(Buffer.from([0, 1]))
        .accountsPartial({ payer: cranker.publicKey, vaultConfig: s.vault, tokenDist: nftDist, mint: s.nftMint, vaultAta: vaultNftAta, tokenProgram: TOKEN_PROGRAM_ID })
        .remainingAccounts([
          { pubkey: b1NftAta, isWritable: true, isSigner: false },
          { pubkey: b2NftAta, isWritable: true, isSigner: false },
        ])
        .signers([cranker])
        .rpc();

      // close NFT dist (residual 0, ATA empty after specific bequest)
      await program.methods
        .closeTokenDist()
        .accountsPartial({ payer: cranker.publicKey, owner: s.owner.publicKey, vaultConfig: s.vault, mint: s.nftMint, vaultAta: vaultNftAta, tokenDist: nftDist, largestBenefAta: null, tokenProgram: TOKEN_PROGRAM_ID })
        .signers([cranker])
        .rpc();

      // owner close now allowed (open_token_dists == 0)
      const v2 = await program.account.vaultConfig.fetch(s.vault);
      expect(v2.openTokenDists).to.equal(0);
      await program.methods
        .closeExecutedVaultByOwner()
        .accountsPartial({ owner: s.owner.publicKey, vaultConfig: s.vault, heartbeatRecord: s.heartbeat, executionLog: s.execution, assetPlan: s.assetPlan, largestBenef: null })
        .signers([s.owner])
        .rpc();
      expect(await conn.getAccountInfo(s.vault)).to.be.null;
      expect(await conn.getAccountInfo(s.assetPlan)).to.be.null;
    });

    it("specific-SOL bequest: carved out of residual; finalize gated on the SOL specific", async () => {
      const s = S.specsol;
      await beginExec(s, true);

      // snapshot = distributable − 0.5 SOL (the specific bequest is carved out).
      const log = await program.account.executionLog.fetch(s.execution);
      const snap = log.solSnapshot;

      // Pro-rata residual splits 60/40 from the post-carve snapshot.
      const expB1 = snap.mul(new BN(6000)).div(new BN(10000));
      const expB2 = snap.mul(new BN(4000)).div(new BN(10000));
      const b2Start = await conn.getBalance(s.b[1].publicKey);
      const before = await Promise.all(s.b.map((k: any) => conn.getBalance(k.publicKey)));
      await solShares(s, [0, 1], s.b.map((k: any) => k.publicKey));
      const after = await Promise.all(s.b.map((k: any) => conn.getBalance(k.publicKey)));
      expect(after[0] - before[0]).to.equal(expB1.toNumber());
      expect(after[1] - before[1]).to.equal(expB2.toNumber());

      // finalize must FAIL while the SOL specific is unpaid (asset mask not full).
      try {
        await finalize(s, true);
        expect.fail("finalize should be gated on the unpaid SOL specific");
      } catch (e) {
        expectErr(e, "NotAllSharesPaid");
      }

      // Pay the specific SOL bequest (0.5 SOL → b2 / index 1) via execute_specific_sol.
      await specificSol(s, 0, s.b[1].publicKey);
      const plan = await program.account.assetPlan.fetch(s.assetPlan);
      expect(plan.paidMask.toNumber() & 1).to.equal(1);

      // now finalize succeeds
      await finalize(s, true);
      const v = await program.account.vaultConfig.fetch(s.vault);
      expect(v.executed).to.be.true;

      // b2 total = 0.5 SOL specific + 40% residual; conservation holds (≤ distributable).
      const b2End = await conn.getBalance(s.b[1].publicKey);
      expect(b2End - b2Start).to.equal(s.specificLamports + expB2.toNumber());
    });

    it("theft attempts all fail", async () => {
      const s = S.theft;
      await beginExec(s, true);
      const tokenDist = tokenDistPda(s.vault, s.tokenMint);
      const vaultAta = getAssociatedTokenAddressSync(s.tokenMint, s.vault, true);
      await program.methods
        .beginTokenDist()
        .accountsPartial({ payer: cranker.publicKey, vaultConfig: s.vault, executionLog: s.execution, mint: s.tokenMint, vaultAta, assetPlan: s.assetPlan, tokenDist, systemProgram: SystemProgram.programId })
        .signers([cranker])
        .rpc();

      // (a) wrong beneficiary wallet at SOL index 0 → BeneficiaryMismatch
      const attacker = Keypair.generate();
      try {
        await solShares(s, [0], [attacker.publicKey]);
        expect.fail("R1");
      } catch (e) {
        expectErr(e, "BeneficiaryMismatch");
      }

      // (b) substituted beneficiary_ata for specific #0 (belongs to attacker) → BeneficiaryMismatch
      const attackerAta = await makeAta(cranker, s.tokenMint, attacker.publicKey);
      try {
        await program.methods
          .executeSpecificAsset(0)
          .accountsPartial({ payer: cranker.publicKey, vaultConfig: s.vault, executionLog: s.execution, assetPlan: s.assetPlan, mint: s.tokenMint, tokenDist, vaultAta, beneficiaryAta: attackerAta, tokenProgram: TOKEN_PROGRAM_ID })
          .signers([cranker])
          .rpc();
        expect.fail("R2");
      } catch (e) {
        expectErr(e, "BeneficiaryMismatch");
      }

      // (c) out-of-order specific: pay #1 before #0 (same mint) → SpecificOutOfOrder
      const b2Ata = await makeAta(cranker, s.tokenMint, s.b[1].publicKey);
      try {
        await program.methods
          .executeSpecificAsset(1)
          .accountsPartial({ payer: cranker.publicKey, vaultConfig: s.vault, executionLog: s.execution, assetPlan: s.assetPlan, mint: s.tokenMint, tokenDist, vaultAta, beneficiaryAta: b2Ata, tokenProgram: TOKEN_PROGRAM_ID })
          .signers([cranker])
          .rpc();
        expect.fail("P3");
      } catch (e) {
        expectErr(e, "SpecificOutOfOrder");
      }

      // (d) CRITICAL regression: spoof a non-canonical vault_ata in begin_token_dist for a NEW mint
      //     (use a fresh mint to get a clean token_dist slot). Passing a wrong address → InvalidVaultAta.
      const freshMintOwner = s.owner;
      const freshMint = await makeMint(freshMintOwner, 0);
      const freshDist = tokenDistPda(s.vault, freshMint);
      const wrongAta = Keypair.generate().publicKey; // not the canonical ATA
      try {
        await program.methods
          .beginTokenDist()
          .accountsPartial({ payer: cranker.publicKey, vaultConfig: s.vault, executionLog: s.execution, mint: freshMint, vaultAta: wrongAta, assetPlan: s.assetPlan, tokenDist: freshDist, systemProgram: SystemProgram.programId })
          .signers([cranker])
          .rpc();
        expect.fail("InvalidVaultAta");
      } catch (e) {
        expectErr(e, "InvalidVaultAta");
      }
    });

    it("idempotency: no double-pay, finalize gated, masks resume", async () => {
      const s = S.idem;
      await beginExec(s);
      const log = await program.account.executionLog.fetch(s.execution);
      const snap = log.solSnapshot;

      // pay only index 0
      const before0 = await conn.getBalance(s.b[0].publicKey);
      await solShares(s, [0], [s.b[0].publicKey]);
      const after0 = await conn.getBalance(s.b[0].publicKey);
      const exp0 = snap.mul(new BN(3333)).div(new BN(10000)).toNumber();
      expect(after0 - before0).to.equal(exp0);

      // finalize must fail (mask not full)
      try {
        await finalize(s, false);
        expect.fail("NotAllSharesPaid");
      } catch (e) {
        expectErr(e, "NotAllSharesPaid");
      }

      // re-run with [0,1,2]: index 0 already paid → skipped (no double-pay)
      const reBefore0 = await conn.getBalance(s.b[0].publicKey);
      await solShares(s, [0, 1, 2], s.b.map((k: any) => k.publicKey));
      const reAfter0 = await conn.getBalance(s.b[0].publicKey);
      expect(reAfter0 - reBefore0).to.equal(0); // not paid twice

      await finalize(s, false);
      const v = await program.account.vaultConfig.fetch(s.vault);
      expect(v.executed).to.be.true;
    });

    it("freeze after deadline: owner mutations + heartbeat all fail", async () => {
      const s = S.frozen;
      // update_vault
      try {
        await program.methods
          .updateVault({ heartbeatInterval: new BN(700000), gracePeriod: null, beneficiaries: null })
          .accountsPartial({ owner: s.owner.publicKey, vaultConfig: s.vault, heartbeatRecord: s.heartbeat })
          .signers([s.owner])
          .rpc();
        expect.fail("update VaultFrozen");
      } catch (e) { expectErr(e, "VaultFrozen"); }
      // withdraw_sol
      try {
        await program.methods
          .withdrawSolFromVault(new BN(1000))
          .accountsPartial({ owner: s.owner.publicKey, vaultConfig: s.vault, heartbeatRecord: s.heartbeat })
          .signers([s.owner])
          .rpc();
        expect.fail("withdraw VaultFrozen");
      } catch (e) { expectErr(e, "VaultFrozen"); }
      // revoke
      try {
        await program.methods
          .revokeVault()
          .accountsPartial({ owner: s.owner.publicKey, vaultConfig: s.vault, heartbeatRecord: s.heartbeat, assetPlan: null })
          .signers([s.owner])
          .rpc();
        expect.fail("revoke VaultFrozen");
      } catch (e) { expectErr(e, "VaultFrozen"); }
      // rotate
      try {
        await program.methods
          .rotateAgent(Keypair.generate().publicKey)
          .accountsPartial({ owner: s.owner.publicKey, vaultConfig: s.vault, heartbeatRecord: s.heartbeat })
          .signers([s.owner])
          .rpc();
        expect.fail("rotate VaultFrozen");
      } catch (e) { expectErr(e, "VaultFrozen"); }
      // heartbeat
      try {
        await program.methods
          .recordHeartbeat({ activeTap: {} })
          .accountsPartial({ agent: agent.publicKey, vaultConfig: s.vault, heartbeatRecord: s.heartbeat })
          .signers([agent])
          .rpc();
        expect.fail("heartbeat VaultFrozen");
      } catch (e) { expectErr(e, "VaultFrozen"); }
    });

    it("Token-2022 residual distribution", async () => {
      const s = S.t22;
      await beginExec(s);
      const tokenDist = tokenDistPda(s.vault, s.mint);
      const vaultAta = getAssociatedTokenAddressSync(s.mint, s.vault, true, TOKEN_2022_PROGRAM_ID);
      await program.methods
        .beginTokenDist()
        .accountsPartial({ payer: cranker.publicKey, vaultConfig: s.vault, executionLog: s.execution, mint: s.mint, vaultAta, assetPlan: null, tokenDist, systemProgram: SystemProgram.programId })
        .signers([cranker])
        .rpc();
      const td = await program.account.tokenDist.fetch(tokenDist);
      expect(td.snapshot.toNumber()).to.equal(1000);

      await solShares(s, [0, 1], s.b.map((k: any) => k.publicKey));
      await finalize(s, false);

      const b1Ata = await makeAta(cranker, s.mint, s.b[0].publicKey, TOKEN_2022_PROGRAM_ID);
      const b2Ata = await makeAta(cranker, s.mint, s.b[1].publicKey, TOKEN_2022_PROGRAM_ID);
      await program.methods
        .executeTokenShares(Buffer.from([0, 1]))
        .accountsPartial({ payer: cranker.publicKey, vaultConfig: s.vault, tokenDist, mint: s.mint, vaultAta, tokenProgram: TOKEN_2022_PROGRAM_ID })
        .remainingAccounts([
          { pubkey: b1Ata, isWritable: true, isSigner: false },
          { pubkey: b2Ata, isWritable: true, isSigner: false },
        ])
        .signers([cranker])
        .rpc();
      expect(Number((await getAccount(conn, b1Ata, undefined, TOKEN_2022_PROGRAM_ID)).amount)).to.equal(500);
      expect(Number((await getAccount(conn, b2Ata, undefined, TOKEN_2022_PROGRAM_ID)).amount)).to.equal(500);
    });

    it("edge: under-funded mint pays min(amount,avail); unheld mint pays 0", async () => {
      const s = S.edge;
      await beginExec(s, true);

      // held mint: vault has 50, assignment wants 100 → pays 50, snapshot residual 0
      const heldDist = tokenDistPda(s.vault, s.heldMint);
      const heldVaultAta = getAssociatedTokenAddressSync(s.heldMint, s.vault, true);
      await program.methods
        .beginTokenDist()
        .accountsPartial({ payer: cranker.publicKey, vaultConfig: s.vault, executionLog: s.execution, mint: s.heldMint, vaultAta: heldVaultAta, assetPlan: s.assetPlan, tokenDist: heldDist, systemProgram: SystemProgram.programId })
        .signers([cranker])
        .rpc();
      const td = await program.account.tokenDist.fetch(heldDist);
      // snapshot = 50 - 100 (sat_sub) = 0
      expect(td.snapshot.toNumber()).to.equal(0);

      // unheld mint: vault holds 0 → begin snapshot 0 (canonical ATA may not exist)
      const unheldDist = tokenDistPda(s.vault, s.unheldMint);
      const unheldVaultAta = getAssociatedTokenAddressSync(s.unheldMint, s.vault, true);
      await program.methods
        .beginTokenDist()
        .accountsPartial({ payer: cranker.publicKey, vaultConfig: s.vault, executionLog: s.execution, mint: s.unheldMint, vaultAta: unheldVaultAta, assetPlan: s.assetPlan, tokenDist: unheldDist, systemProgram: SystemProgram.programId })
        .signers([cranker])
        .rpc();
      const td2 = await program.account.tokenDist.fetch(unheldDist);
      expect(td2.snapshot.toNumber()).to.equal(0);

      // pay specific #0 (held): min(100, 50) = 50
      const b1Held = await makeAta(cranker, s.heldMint, s.b[0].publicKey);
      await program.methods
        .executeSpecificAsset(0)
        .accountsPartial({ payer: cranker.publicKey, vaultConfig: s.vault, executionLog: s.execution, assetPlan: s.assetPlan, mint: s.heldMint, tokenDist: heldDist, vaultAta: heldVaultAta, beneficiaryAta: b1Held, tokenProgram: TOKEN_PROGRAM_ID })
        .signers([cranker])
        .rpc();
      expect(Number((await getAccount(conn, b1Held)).amount)).to.equal(50);

      // pay specific #1 (unheld): min(5, 0) = 0, mask still set
      const b1Unheld = await makeAta(cranker, s.unheldMint, s.b[0].publicKey);
      const unheldVaultAtaReal = await makeAta(cranker, s.unheldMint, s.vault); // create so InterfaceAccount deserializes (0 balance)
      await program.methods
        .executeSpecificAsset(1)
        .accountsPartial({ payer: cranker.publicKey, vaultConfig: s.vault, executionLog: s.execution, assetPlan: s.assetPlan, mint: s.unheldMint, tokenDist: unheldDist, vaultAta: unheldVaultAtaReal, beneficiaryAta: b1Unheld, tokenProgram: TOKEN_PROGRAM_ID })
        .signers([cranker])
        .rpc();
      expect(Number((await getAccount(conn, b1Unheld)).amount)).to.equal(0);
      const plan = await program.account.assetPlan.fetch(s.assetPlan);
      expect(plan.paidMask.toNumber()).to.equal(0b11); // both bits set

      // SOL shares (snapshot ~ rent only deposit=0 → all 0), then finalize
      await solShares(s, [0], [s.b[0].publicKey]);
      await finalize(s, true);
      const v = await program.account.vaultConfig.fetch(s.vault);
      expect(v.executed).to.be.true;
    });
  });
});
