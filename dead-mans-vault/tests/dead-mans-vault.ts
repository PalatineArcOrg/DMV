import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DeadMansVault } from "../target/types/dead_mans_vault";
import { expect } from "chai";

describe("dead-mans-vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.deadMansVault as Program<DeadMansVault>;
  const owner = provider.wallet;
  const agent = anchor.web3.Keypair.generate();
  const beneficiary1 = anchor.web3.Keypair.generate();
  const beneficiary2 = anchor.web3.Keypair.generate();

  let vaultConfigPda: anchor.web3.PublicKey;
  let vaultConfigBump: number;
  let heartbeatRecordPda: anchor.web3.PublicKey;

  before(async () => {
    [vaultConfigPda, vaultConfigBump] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), owner.publicKey.toBuffer()],
        program.programId
      );
    [heartbeatRecordPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("heartbeat"), vaultConfigPda.toBuffer()],
      program.programId
    );
  });

  // ─── Initialize Vault ───

  it("initializes vault successfully", async () => {
    await program.methods
      .initializeVault({
        agentPubkey: agent.publicKey,
        heartbeatInterval: new anchor.BN(604800), // 7 days
        gracePeriod: new anchor.BN(2073600), // 24 days
        beneficiaries: [
          {
            wallet: beneficiary1.publicKey,
            shareBps: 7000,
            hasSpecificAssets: false,
          },
          {
            wallet: beneficiary2.publicKey,
            shareBps: 3000,
            hasSpecificAssets: false,
          },
        ],
        isMutable: true,
      })
      .accounts({
        owner: owner.publicKey,
        vaultConfig: vaultConfigPda,
        heartbeatRecord: heartbeatRecordPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const vault = await program.account.vaultConfig.fetch(vaultConfigPda);
    expect(vault.owner.toString()).to.equal(owner.publicKey.toString());
    expect(vault.agentPubkey.toString()).to.equal(agent.publicKey.toString());
    expect(vault.heartbeatInterval.toNumber()).to.equal(604800);
    expect(vault.gracePeriod.toNumber()).to.equal(2073600);
    expect(vault.beneficiaries.length).to.equal(2);
    expect(vault.beneficiaries[0].shareBps).to.equal(7000);
    expect(vault.beneficiaries[1].shareBps).to.equal(3000);
    expect(vault.executed).to.be.false;
    expect(vault.active).to.be.true;

    const heartbeat = await program.account.heartbeatRecord.fetch(
      heartbeatRecordPda
    );
    expect(heartbeat.vault.toString()).to.equal(vaultConfigPda.toString());
    expect(heartbeat.totalHeartbeats.toNumber()).to.equal(1);
  });

  // ─── Initialize Vault Error Cases ───

  it("rejects heartbeat interval too short", async () => {
    const newOwner = anchor.web3.Keypair.generate();
    await airdrop(provider, newOwner.publicKey, 1);

    const [newVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), newOwner.publicKey.toBuffer()],
      program.programId
    );
    const [newHeartbeatPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("heartbeat"), newVaultPda.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .initializeVault({
          agentPubkey: agent.publicKey,
          heartbeatInterval: new anchor.BN(100), // too short
          gracePeriod: new anchor.BN(604800),
          beneficiaries: [
            {
              wallet: beneficiary1.publicKey,
              shareBps: 10000,
              hasSpecificAssets: false,
            },
          ],
          isMutable: true,
        })
        .accounts({
          owner: newOwner.publicKey,
          vaultConfig: newVaultPda,
          heartbeatRecord: newHeartbeatPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([newOwner])
        .rpc();
      expect.fail("Should have thrown HeartbeatIntervalTooShort");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("HeartbeatIntervalTooShort");
    }
  });

  it("rejects grace period too short", async () => {
    const newOwner = anchor.web3.Keypair.generate();
    await airdrop(provider, newOwner.publicKey, 1);

    const [newVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), newOwner.publicKey.toBuffer()],
      program.programId
    );
    const [newHeartbeatPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("heartbeat"), newVaultPda.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .initializeVault({
          agentPubkey: agent.publicKey,
          heartbeatInterval: new anchor.BN(86400),
          gracePeriod: new anchor.BN(100), // too short
          beneficiaries: [
            {
              wallet: beneficiary1.publicKey,
              shareBps: 10000,
              hasSpecificAssets: false,
            },
          ],
          isMutable: true,
        })
        .accounts({
          owner: newOwner.publicKey,
          vaultConfig: newVaultPda,
          heartbeatRecord: newHeartbeatPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([newOwner])
        .rpc();
      expect.fail("Should have thrown GracePeriodTooShort");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("GracePeriodTooShort");
    }
  });

  it("rejects invalid beneficiary shares (not 10000 bps)", async () => {
    const newOwner = anchor.web3.Keypair.generate();
    await airdrop(provider, newOwner.publicKey, 1);

    const [newVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), newOwner.publicKey.toBuffer()],
      program.programId
    );
    const [newHeartbeatPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("heartbeat"), newVaultPda.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .initializeVault({
          agentPubkey: agent.publicKey,
          heartbeatInterval: new anchor.BN(86400),
          gracePeriod: new anchor.BN(604800),
          beneficiaries: [
            {
              wallet: beneficiary1.publicKey,
              shareBps: 5000,
              hasSpecificAssets: false,
            },
            {
              wallet: beneficiary2.publicKey,
              shareBps: 4000,
              hasSpecificAssets: false,
            },
          ],
          isMutable: true,
        })
        .accounts({
          owner: newOwner.publicKey,
          vaultConfig: newVaultPda,
          heartbeatRecord: newHeartbeatPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([newOwner])
        .rpc();
      expect.fail("Should have thrown InvalidShareAllocation");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("InvalidShareAllocation");
    }
  });

  it("rejects empty beneficiaries list", async () => {
    const newOwner = anchor.web3.Keypair.generate();
    await airdrop(provider, newOwner.publicKey, 1);

    const [newVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), newOwner.publicKey.toBuffer()],
      program.programId
    );
    const [newHeartbeatPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("heartbeat"), newVaultPda.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .initializeVault({
          agentPubkey: agent.publicKey,
          heartbeatInterval: new anchor.BN(86400),
          gracePeriod: new anchor.BN(604800),
          beneficiaries: [],
          isMutable: true,
        })
        .accounts({
          owner: newOwner.publicKey,
          vaultConfig: newVaultPda,
          heartbeatRecord: newHeartbeatPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([newOwner])
        .rpc();
      expect.fail("Should have thrown InvalidBeneficiaryCount");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("InvalidBeneficiaryCount");
    }
  });

  it("rejects owner as beneficiary", async () => {
    const newOwner = anchor.web3.Keypair.generate();
    await airdrop(provider, newOwner.publicKey, 1);

    const [newVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), newOwner.publicKey.toBuffer()],
      program.programId
    );
    const [newHeartbeatPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("heartbeat"), newVaultPda.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .initializeVault({
          agentPubkey: agent.publicKey,
          heartbeatInterval: new anchor.BN(86400),
          gracePeriod: new anchor.BN(604800),
          beneficiaries: [
            {
              wallet: newOwner.publicKey, // owner as beneficiary
              shareBps: 10000,
              hasSpecificAssets: false,
            },
          ],
          isMutable: true,
        })
        .accounts({
          owner: newOwner.publicKey,
          vaultConfig: newVaultPda,
          heartbeatRecord: newHeartbeatPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([newOwner])
        .rpc();
      expect.fail("Should have thrown OwnerCannotBeBeneficiary");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("OwnerCannotBeBeneficiary");
    }
  });

  // ─── Record Heartbeat ───

  it("records heartbeat from authorized agent", async () => {
    const hbBefore = await program.account.heartbeatRecord.fetch(
      heartbeatRecordPda
    );
    const countBefore = hbBefore.totalHeartbeats.toNumber();

    await program.methods
      .recordHeartbeat({ activeTap: {} })
      .accounts({
        agent: agent.publicKey,
        vaultConfig: vaultConfigPda,
        heartbeatRecord: heartbeatRecordPda,
      })
      .signers([agent])
      .rpc();

    const hbAfter = await program.account.heartbeatRecord.fetch(
      heartbeatRecordPda
    );
    expect(hbAfter.totalHeartbeats.toNumber()).to.equal(countBefore + 1);
    expect(hbAfter.lastHeartbeat.toNumber()).to.be.greaterThan(0);
  });

  it("rejects heartbeat from non-agent", async () => {
    const fakeAgent = anchor.web3.Keypair.generate();

    try {
      await program.methods
        .recordHeartbeat({ activeTap: {} })
        .accounts({
          agent: fakeAgent.publicKey,
          vaultConfig: vaultConfigPda,
          heartbeatRecord: heartbeatRecordPda,
        })
        .signers([fakeAgent])
        .rpc();
      expect.fail("Should have thrown UnauthorizedAgent");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("UnauthorizedAgent");
    }
  });

  // ─── Update Vault ───

  it("allows owner to update vault config", async () => {
    await program.methods
      .updateVault({
        heartbeatInterval: new anchor.BN(172800), // 2 days
        gracePeriod: null,
        beneficiaries: null,
      })
      .accounts({
        owner: owner.publicKey,
        vaultConfig: vaultConfigPda,
      })
      .rpc();

    const vault = await program.account.vaultConfig.fetch(vaultConfigPda);
    expect(vault.heartbeatInterval.toNumber()).to.equal(172800);
    // Grace period unchanged
    expect(vault.gracePeriod.toNumber()).to.equal(2073600);
  });

  it("rejects update from non-owner", async () => {
    const impostor = anchor.web3.Keypair.generate();

    try {
      await program.methods
        .updateVault({
          heartbeatInterval: new anchor.BN(172800),
          gracePeriod: null,
          beneficiaries: null,
        })
        .accounts({
          owner: impostor.publicKey,
          vaultConfig: vaultConfigPda,
        })
        .signers([impostor])
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      // has_one = owner constraint
      expect(err.error).to.exist;
    }
  });

  // ─── Rotate Agent ───

  it("allows owner to rotate agent key", async () => {
    const newAgent = anchor.web3.Keypair.generate();

    await program.methods
      .rotateAgent(newAgent.publicKey)
      .accounts({
        owner: owner.publicKey,
        vaultConfig: vaultConfigPda,
        heartbeatRecord: heartbeatRecordPda,
      })
      .rpc();

    const vault = await program.account.vaultConfig.fetch(vaultConfigPda);
    expect(vault.agentPubkey.toString()).to.equal(
      newAgent.publicKey.toString()
    );

    // Heartbeat should have been reset
    const hb = await program.account.heartbeatRecord.fetch(
      heartbeatRecordPda
    );
    expect(hb.lastHeartbeat.toNumber()).to.be.greaterThan(0);

    // Verify old agent can no longer heartbeat
    try {
      await program.methods
        .recordHeartbeat({ activeTap: {} })
        .accounts({
          agent: agent.publicKey, // old agent
          vaultConfig: vaultConfigPda,
          heartbeatRecord: heartbeatRecordPda,
        })
        .signers([agent])
        .rpc();
      expect.fail("Old agent should be rejected");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("UnauthorizedAgent");
    }

    // New agent CAN heartbeat
    await program.methods
      .recordHeartbeat({ activeTap: {} })
      .accounts({
        agent: newAgent.publicKey,
        vaultConfig: vaultConfigPda,
        heartbeatRecord: heartbeatRecordPda,
      })
      .signers([newAgent])
      .rpc();

    const hbAfter = await program.account.heartbeatRecord.fetch(
      heartbeatRecordPda
    );
    expect(hbAfter.totalHeartbeats.toNumber()).to.be.greaterThan(0);

    // Rotate back to original agent for subsequent tests
    await program.methods
      .rotateAgent(agent.publicKey)
      .accounts({
        owner: owner.publicKey,
        vaultConfig: vaultConfigPda,
        heartbeatRecord: heartbeatRecordPda,
      })
      .rpc();
  });

  it("rejects agent rotation from non-owner", async () => {
    const newAgent = anchor.web3.Keypair.generate();

    try {
      await program.methods
        .rotateAgent(newAgent.publicKey)
        .accounts({
          owner: agent.publicKey, // agent trying to rotate — NOT allowed
          vaultConfig: vaultConfigPda,
          heartbeatRecord: heartbeatRecordPda,
        })
        .signers([agent])
        .rpc();
      expect.fail("Should have thrown UnauthorizedOwner");
    } catch (err: any) {
      expect(err.error).to.exist;
    }
  });

  it("rejects rotation to zero address", async () => {
    try {
      await program.methods
        .rotateAgent(anchor.web3.PublicKey.default)
        .accounts({
          owner: owner.publicKey,
          vaultConfig: vaultConfigPda,
          heartbeatRecord: heartbeatRecordPda,
        })
        .rpc();
      expect.fail("Should have thrown InvalidAgentPubkey");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("InvalidAgentPubkey");
    }
  });

  it("rejects rotation to owner address", async () => {
    try {
      await program.methods
        .rotateAgent(owner.publicKey)
        .accounts({
          owner: owner.publicKey,
          vaultConfig: vaultConfigPda,
          heartbeatRecord: heartbeatRecordPda,
        })
        .rpc();
      expect.fail("Should have thrown AgentCannotBeOwner");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("AgentCannotBeOwner");
    }
  });

  it("rejects rotation to same agent key", async () => {
    try {
      await program.methods
        .rotateAgent(agent.publicKey) // same as current
        .accounts({
          owner: owner.publicKey,
          vaultConfig: vaultConfigPda,
          heartbeatRecord: heartbeatRecordPda,
        })
        .rpc();
      expect.fail("Should have thrown AgentKeyUnchanged");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("AgentKeyUnchanged");
    }
  });

  // ─── Execution Guards ───

  it("rejects SOL distribution before grace period elapsed", async () => {
    // Grace period hasn't elapsed — execute_sol_distribution should fail
    try {
      await program.methods
        .executeSolDistribution(new anchor.BN(1000))
        .accounts({
          agent: agent.publicKey,
          vaultConfig: vaultConfigPda,
          heartbeatRecord: heartbeatRecordPda,
          beneficiary: beneficiary1.publicKey,
        })
        .signers([agent])
        .rpc();
      expect.fail("Should have thrown GracePeriodNotElapsed");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("GracePeriodNotElapsed");
    }
  });

  it("rejects SOL distribution from unauthorized agent", async () => {
    const fakeAgent = anchor.web3.Keypair.generate();
    try {
      await program.methods
        .executeSolDistribution(new anchor.BN(1000))
        .accounts({
          agent: fakeAgent.publicKey,
          vaultConfig: vaultConfigPda,
          heartbeatRecord: heartbeatRecordPda,
          beneficiary: beneficiary1.publicKey,
        })
        .signers([fakeAgent])
        .rpc();
      expect.fail("Should have thrown UnauthorizedAgent");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("UnauthorizedAgent");
    }
  });

  it("rejects SOL distribution to unregistered beneficiary", async () => {
    const unregistered = anchor.web3.Keypair.generate();
    try {
      await program.methods
        .executeSolDistribution(new anchor.BN(1000))
        .accounts({
          agent: agent.publicKey,
          vaultConfig: vaultConfigPda,
          heartbeatRecord: heartbeatRecordPda,
          beneficiary: unregistered.publicKey,
        })
        .signers([agent])
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      // Either GracePeriodNotElapsed (checked first) or UnregisteredBeneficiary
      expect(err.error).to.exist;
    }
  });

  // ─── Revoke Vault ───

  it("allows owner to revoke vault (closes accounts)", async () => {
    await program.methods
      .revokeVault()
      .accounts({
        owner: owner.publicKey,
        vaultConfig: vaultConfigPda,
        heartbeatRecord: heartbeatRecordPda,
      })
      .rpc();

    // Both accounts should be closed (null)
    const vaultAccount = await provider.connection.getAccountInfo(vaultConfigPda);
    expect(vaultAccount).to.be.null;
    const heartbeatAccount = await provider.connection.getAccountInfo(heartbeatRecordPda);
    expect(heartbeatAccount).to.be.null;
  });

  it("rejects heartbeat on closed vault", async () => {
    try {
      await program.methods
        .recordHeartbeat({ activeTap: {} })
        .accounts({
          agent: agent.publicKey,
          vaultConfig: vaultConfigPda,
          heartbeatRecord: heartbeatRecordPda,
        })
        .signers([agent])
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      // Closed account → AccountNotInitialized
      expect(err.toString()).to.include("AccountNotInitialized");
    }
  });

  it("rejects rotation on closed vault", async () => {
    const newAgent = anchor.web3.Keypair.generate();
    try {
      await program.methods
        .rotateAgent(newAgent.publicKey)
        .accounts({
          owner: owner.publicKey,
          vaultConfig: vaultConfigPda,
          heartbeatRecord: heartbeatRecordPda,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("AccountNotInitialized");
    }
  });

  it("allows re-initialization after revoke", async () => {
    // Shared vault was closed by revoke above — re-init on the same PDA
    const newAgent = anchor.web3.Keypair.generate();
    await program.methods
      .initializeVault({
        agentPubkey: newAgent.publicKey,
        heartbeatInterval: new anchor.BN(86400),
        gracePeriod: new anchor.BN(604800),
        beneficiaries: [
          {
            wallet: beneficiary1.publicKey,
            shareBps: 10000,
            hasSpecificAssets: false,
          },
        ],
        isMutable: true,
      })
      .accounts({
        owner: owner.publicKey,
        vaultConfig: vaultConfigPda,
        heartbeatRecord: heartbeatRecordPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const vault = await program.account.vaultConfig.fetch(vaultConfigPda);
    expect(vault.active).to.be.true;
    expect(vault.agentPubkey.toString()).to.equal(newAgent.publicKey.toString());
    expect(vault.beneficiaries.length).to.equal(1);

    // Revoke again to leave clean state (closed) for subsequent tests
    await program.methods
      .revokeVault()
      .accounts({
        owner: owner.publicKey,
        vaultConfig: vaultConfigPda,
        heartbeatRecord: heartbeatRecordPda,
      })
      .rpc();
  });

  it("rejects revoke from non-owner", async () => {
    // Create a new vault for this test
    const newOwner = anchor.web3.Keypair.generate();
    await airdrop(provider, newOwner.publicKey, 1);

    const [newVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), newOwner.publicKey.toBuffer()],
      program.programId
    );
    const [newHeartbeatPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("heartbeat"), newVaultPda.toBuffer()],
      program.programId
    );

    await program.methods
      .initializeVault({
        agentPubkey: agent.publicKey,
        heartbeatInterval: new anchor.BN(86400),
        gracePeriod: new anchor.BN(604800),
        beneficiaries: [
          {
            wallet: beneficiary1.publicKey,
            shareBps: 10000,
            hasSpecificAssets: false,
          },
        ],
        isMutable: true,
      })
      .accounts({
        owner: newOwner.publicKey,
        vaultConfig: newVaultPda,
        heartbeatRecord: newHeartbeatPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([newOwner])
      .rpc();

    // Try revoking from a different signer
    const impostor = anchor.web3.Keypair.generate();
    try {
      await program.methods
        .revokeVault()
        .accounts({
          owner: impostor.publicKey,
          vaultConfig: newVaultPda,
          heartbeatRecord: newHeartbeatPda,
        })
        .signers([impostor])
        .rpc();
      expect.fail("Should have thrown UnauthorizedOwner");
    } catch (err: any) {
      expect(err.error).to.exist;
    }
  });

  // ─── Record Execution ───

  it("rejects record_execution before grace period elapsed", async () => {
    // record_execution now enforces grace period to prevent a compromised
    // agent from sealing a vault before the owner's deadline has passed.
    const execOwner = anchor.web3.Keypair.generate();
    await airdrop(provider, execOwner.publicKey, 1);
    const execAgent = anchor.web3.Keypair.generate();

    const [execVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), execOwner.publicKey.toBuffer()],
      program.programId
    );
    const [execHeartbeatPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("heartbeat"), execVaultPda.toBuffer()],
      program.programId
    );
    const [execLogPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("execution"), execVaultPda.toBuffer()],
      program.programId
    );

    // Initialize
    await program.methods
      .initializeVault({
        agentPubkey: execAgent.publicKey,
        heartbeatInterval: new anchor.BN(86400),
        gracePeriod: new anchor.BN(604800),
        beneficiaries: [
          {
            wallet: beneficiary1.publicKey,
            shareBps: 10000,
            hasSpecificAssets: false,
          },
        ],
        isMutable: true,
      })
      .accounts({
        owner: execOwner.publicKey,
        vaultConfig: execVaultPda,
        heartbeatRecord: execHeartbeatPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([execOwner])
      .rpc();

    // Attempt record_execution immediately — should fail (grace period not elapsed)
    try {
      await program.methods
        .recordExecution({
          transferCount: 5,
          totalSolDistributed: new anchor.BN(1000000000),
          tokenTypesDistributed: 3,
          attestationHash: Array.from(Buffer.alloc(32, 0xab)),
          completed: true,
        })
        .accounts({
          agent: execAgent.publicKey,
          payer: execOwner.publicKey,
          vaultConfig: execVaultPda,
          heartbeatRecord: execHeartbeatPda,
          executionLog: execLogPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([execAgent, execOwner])
        .rpc();
      expect.fail("Should have thrown GracePeriodNotElapsed");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("GracePeriodNotElapsed");
    }
  });

  it("rejects record_execution from unauthorized agent", async () => {
    const rexOwner = anchor.web3.Keypair.generate();
    await airdrop(provider, rexOwner.publicKey, 1);
    const rexAgent = anchor.web3.Keypair.generate();
    const fakeAgent = anchor.web3.Keypair.generate();

    const [rexVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), rexOwner.publicKey.toBuffer()],
      program.programId
    );
    const [rexHeartbeatPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("heartbeat"), rexVaultPda.toBuffer()],
      program.programId
    );
    const [rexLogPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("execution"), rexVaultPda.toBuffer()],
      program.programId
    );

    // Initialize
    await program.methods
      .initializeVault({
        agentPubkey: rexAgent.publicKey,
        heartbeatInterval: new anchor.BN(86400),
        gracePeriod: new anchor.BN(604800),
        beneficiaries: [
          {
            wallet: beneficiary1.publicKey,
            shareBps: 10000,
            hasSpecificAssets: false,
          },
        ],
        isMutable: true,
      })
      .accounts({
        owner: rexOwner.publicKey,
        vaultConfig: rexVaultPda,
        heartbeatRecord: rexHeartbeatPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([rexOwner])
      .rpc();

    // Attempt record_execution from fake agent — should fail
    try {
      await program.methods
        .recordExecution({
          transferCount: 1,
          totalSolDistributed: new anchor.BN(100),
          tokenTypesDistributed: 1,
          attestationHash: Array.from(Buffer.alloc(32, 0)),
          completed: true,
        })
        .accounts({
          agent: fakeAgent.publicKey,
          payer: rexOwner.publicKey,
          vaultConfig: rexVaultPda,
          heartbeatRecord: rexHeartbeatPda,
          executionLog: rexLogPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([fakeAgent, rexOwner])
        .rpc();
      expect.fail("Should have thrown UnauthorizedAgent");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("UnauthorizedAgent");
    }
  });

  // ─── Immutability Guards ───

  it("rejects update on immutable vault", async () => {
    const immOwner = anchor.web3.Keypair.generate();
    await airdrop(provider, immOwner.publicKey, 1);
    const immAgent = anchor.web3.Keypair.generate();

    const [immVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), immOwner.publicKey.toBuffer()],
      program.programId
    );
    const [immHeartbeatPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("heartbeat"), immVaultPda.toBuffer()],
      program.programId
    );

    // Initialize as immutable
    await program.methods
      .initializeVault({
        agentPubkey: immAgent.publicKey,
        heartbeatInterval: new anchor.BN(86400),
        gracePeriod: new anchor.BN(604800),
        beneficiaries: [
          {
            wallet: beneficiary1.publicKey,
            shareBps: 10000,
            hasSpecificAssets: false,
          },
        ],
        isMutable: false,
      })
      .accounts({
        owner: immOwner.publicKey,
        vaultConfig: immVaultPda,
        heartbeatRecord: immHeartbeatPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([immOwner])
      .rpc();

    // Try to update — should fail with VaultImmutable
    try {
      await program.methods
        .updateVault({
          heartbeatInterval: new anchor.BN(172800),
          gracePeriod: null,
          beneficiaries: null,
        })
        .accounts({
          owner: immOwner.publicKey,
          vaultConfig: immVaultPda,
        })
        .signers([immOwner])
        .rpc();
      expect.fail("Should have thrown VaultImmutable");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("VaultImmutable");
    }
  });

  it("rejects revoke on immutable vault", async () => {
    const immOwner2 = anchor.web3.Keypair.generate();
    await airdrop(provider, immOwner2.publicKey, 1);
    const immAgent2 = anchor.web3.Keypair.generate();

    const [immVaultPda2] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), immOwner2.publicKey.toBuffer()],
      program.programId
    );
    const [immHeartbeatPda2] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("heartbeat"), immVaultPda2.toBuffer()],
      program.programId
    );

    // Initialize as immutable
    await program.methods
      .initializeVault({
        agentPubkey: immAgent2.publicKey,
        heartbeatInterval: new anchor.BN(86400),
        gracePeriod: new anchor.BN(604800),
        beneficiaries: [
          {
            wallet: beneficiary1.publicKey,
            shareBps: 10000,
            hasSpecificAssets: false,
          },
        ],
        isMutable: false,
      })
      .accounts({
        owner: immOwner2.publicKey,
        vaultConfig: immVaultPda2,
        heartbeatRecord: immHeartbeatPda2,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([immOwner2])
      .rpc();

    try {
      await program.methods
        .revokeVault()
        .accounts({
          owner: immOwner2.publicKey,
          vaultConfig: immVaultPda2,
          heartbeatRecord: immHeartbeatPda2,
        })
        .signers([immOwner2])
        .rpc();
      expect.fail("Should have thrown VaultImmutable");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("VaultImmutable");
    }
  });

  // ─── Record Execution on Inactive Vault ───

  it("rejects record_execution on closed vault", async () => {
    const inactiveOwner = anchor.web3.Keypair.generate();
    await airdrop(provider, inactiveOwner.publicKey, 1);
    const inactiveAgent = anchor.web3.Keypair.generate();

    const [inactiveVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), inactiveOwner.publicKey.toBuffer()],
      program.programId
    );
    const [inactiveHeartbeatPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("heartbeat"), inactiveVaultPda.toBuffer()],
      program.programId
    );
    const [inactiveLogPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("execution"), inactiveVaultPda.toBuffer()],
      program.programId
    );

    // Initialize
    await program.methods
      .initializeVault({
        agentPubkey: inactiveAgent.publicKey,
        heartbeatInterval: new anchor.BN(86400),
        gracePeriod: new anchor.BN(604800),
        beneficiaries: [
          {
            wallet: beneficiary1.publicKey,
            shareBps: 10000,
            hasSpecificAssets: false,
          },
        ],
        isMutable: true,
      })
      .accounts({
        owner: inactiveOwner.publicKey,
        vaultConfig: inactiveVaultPda,
        heartbeatRecord: inactiveHeartbeatPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([inactiveOwner])
      .rpc();

    // Revoke the vault (closes both accounts)
    await program.methods
      .revokeVault()
      .accounts({
        owner: inactiveOwner.publicKey,
        vaultConfig: inactiveVaultPda,
        heartbeatRecord: inactiveHeartbeatPda,
      })
      .signers([inactiveOwner])
      .rpc();

    // Try record_execution on closed vault — should fail
    try {
      await program.methods
        .recordExecution({
          transferCount: 1,
          totalSolDistributed: new anchor.BN(0),
          tokenTypesDistributed: 0,
          attestationHash: Array.from(Buffer.alloc(32, 0)),
          completed: true,
        })
        .accounts({
          agent: inactiveAgent.publicKey,
          payer: inactiveOwner.publicKey,
          vaultConfig: inactiveVaultPda,
          heartbeatRecord: inactiveHeartbeatPda,
          executionLog: inactiveLogPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([inactiveAgent, inactiveOwner])
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      // Closed account → AccountNotInitialized
      expect(err.toString()).to.include("AccountNotInitialized");
    }
  });

  // ─── Revoke Already Closed ───

  it("rejects revoking an already closed vault", async () => {
    const revOwner = anchor.web3.Keypair.generate();
    await airdrop(provider, revOwner.publicKey, 1);
    const revAgent = anchor.web3.Keypair.generate();

    const [revVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), revOwner.publicKey.toBuffer()],
      program.programId
    );
    const [revHeartbeatPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("heartbeat"), revVaultPda.toBuffer()],
      program.programId
    );

    // Initialize
    await program.methods
      .initializeVault({
        agentPubkey: revAgent.publicKey,
        heartbeatInterval: new anchor.BN(86400),
        gracePeriod: new anchor.BN(604800),
        beneficiaries: [
          {
            wallet: beneficiary1.publicKey,
            shareBps: 10000,
            hasSpecificAssets: false,
          },
        ],
        isMutable: true,
      })
      .accounts({
        owner: revOwner.publicKey,
        vaultConfig: revVaultPda,
        heartbeatRecord: revHeartbeatPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([revOwner])
      .rpc();

    // First revoke — closes accounts
    await program.methods
      .revokeVault()
      .accounts({
        owner: revOwner.publicKey,
        vaultConfig: revVaultPda,
        heartbeatRecord: revHeartbeatPda,
      })
      .signers([revOwner])
      .rpc();

    // Second revoke — account doesn't exist
    try {
      await program.methods
        .revokeVault()
        .accounts({
          owner: revOwner.publicKey,
          vaultConfig: revVaultPda,
          heartbeatRecord: revHeartbeatPda,
        })
        .signers([revOwner])
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("AccountNotInitialized");
    }
  });

  // ─── Close Revoked Vault ───

  it("rejects close_revoked_vault on active vault", async () => {
    const crvOwner = anchor.web3.Keypair.generate();
    await airdrop(provider, crvOwner.publicKey, 1);
    const crvAgent = anchor.web3.Keypair.generate();

    const [crvVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), crvOwner.publicKey.toBuffer()],
      program.programId
    );
    const [crvHeartbeatPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("heartbeat"), crvVaultPda.toBuffer()],
      program.programId
    );

    // Initialize (active vault)
    await program.methods
      .initializeVault({
        agentPubkey: crvAgent.publicKey,
        heartbeatInterval: new anchor.BN(86400),
        gracePeriod: new anchor.BN(604800),
        beneficiaries: [
          {
            wallet: beneficiary1.publicKey,
            shareBps: 10000,
            hasSpecificAssets: false,
          },
        ],
        isMutable: true,
      })
      .accounts({
        owner: crvOwner.publicKey,
        vaultConfig: crvVaultPda,
        heartbeatRecord: crvHeartbeatPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([crvOwner])
      .rpc();

    // Try to close an active vault — should fail with VaultStillActive
    try {
      await program.methods
        .closeRevokedVault()
        .accounts({
          owner: crvOwner.publicKey,
          vaultConfig: crvVaultPda,
          heartbeatRecord: crvHeartbeatPda,
        })
        .signers([crvOwner])
        .rpc();
      expect.fail("Should have thrown VaultStillActive");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("VaultStillActive");
    }
  });
});

// Helper: airdrop SOL to an account
async function airdrop(
  provider: anchor.AnchorProvider,
  to: anchor.web3.PublicKey,
  amount: number
) {
  const sig = await provider.connection.requestAirdrop(
    to,
    amount * anchor.web3.LAMPORTS_PER_SOL
  );
  await provider.connection.confirmTransaction(sig, "confirmed");
}
