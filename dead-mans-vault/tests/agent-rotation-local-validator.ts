import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import bs58 from "bs58";
import { DeadMansVault } from "../target/types/dead_mans_vault";
import {
  createAgentKeySlotManager,
  type AgentKeySlotStorage,
} from "../app/src/tee/AgentKeySlotManagerCore";

const {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} = anchor.web3;

const FEE_WALLET = new PublicKey(
  "98x9Rn63Ne8xbL3w522zgbuYg9bdHn7cRqJQVCUZUFsp"
);

describe("WP 4.7 disposable local-validator rotation", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program =
    anchor.workspace.deadMansVault as Program<DeadMansVault>;
  const connection = provider.connection;

  async function fund(publicKey: anchor.web3.PublicKey): Promise<void> {
    const signature = await connection.requestAirdrop(
      publicKey,
      LAMPORTS_PER_SOL
    );
    const blockhash = await connection.getLatestBlockhash("confirmed");
    await connection.confirmTransaction(
      { signature, ...blockhash },
      "confirmed"
    );
  }

  before(async () => {
    await fund(provider.wallet.publicKey);
  });

  function pdas(owner: anchor.web3.PublicKey) {
    const [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), owner.toBuffer()],
      program.programId
    );
    const [heartbeat] = PublicKey.findProgramAddressSync(
      [Buffer.from("heartbeat"), vault.toBuffer()],
      program.programId
    );
    return { vault, heartbeat };
  }

  async function initialize(
    owner: anchor.web3.Keypair,
    agent: anchor.web3.PublicKey,
    interval = 100,
    grace = 100
  ) {
    await fund(owner.publicKey);
    const { vault, heartbeat } = pdas(owner.publicKey);
    await program.methods
      .initializeVault({
        agentPubkey: agent,
        heartbeatInterval: new BN(interval),
        gracePeriod: new BN(grace),
        beneficiaries: [
          {
            wallet: Keypair.generate().publicKey,
            shareBps: 10_000,
          },
        ],
        isMutable: true,
        keeperBounty: new BN(0),
      })
      .accountsPartial({
        owner: owner.publicKey,
        vaultConfig: vault,
        heartbeatRecord: heartbeat,
        feeRecipient: FEE_WALLET,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();
    return { vault, heartbeat };
  }

  async function buildDualSignedRotation(
    owner: anchor.web3.Keypair,
    candidate: anchor.web3.Keypair,
    vault: anchor.web3.PublicKey,
    heartbeat: anchor.web3.PublicKey
  ) {
    await fund(candidate.publicKey);
    const transaction = await program.methods
      .rotateAgent(candidate.publicKey)
      .accountsPartial({
        owner: owner.publicKey,
        vaultConfig: vault,
        heartbeatRecord: heartbeat,
      })
      .transaction();
    transaction.feePayer = candidate.publicKey;
    const blockhash =
      await connection.getLatestBlockhash("confirmed");
    transaction.recentBlockhash = blockhash.blockhash;
    transaction.partialSign(candidate);
    const candidateSignature = Buffer.from(transaction.signature!);
    transaction.partialSign(owner);
    expect(transaction.verifySignatures()).to.equal(true);
    expect(
      transaction.signatures[0].publicKey.equals(candidate.publicKey)
    ).to.equal(true);
    expect(Buffer.from(transaction.signature!)).to.deep.equal(
      candidateSignature
    );
    return { transaction, blockhash, candidateSignature };
  }

  function restartableSlots(
    active: anchor.web3.Keypair,
    candidate: anchor.web3.Keypair
  ) {
    const values = new Map<string, string>();
    const storage: AgentKeySlotStorage = {
      get: async (key) => values.get(key) ?? null,
      set: async (key, value, authenticated) => {
        values.set(key, value);
        return authenticated;
      },
      remove: async (key) => {
        values.delete(key);
      },
    };
    let generated = 0;
    const initial = createAgentKeySlotManager(
      storage,
      () => [active, candidate][generated++]
    );
    return { storage, initial };
  }

  it("funds B, requires B+owner, rotates once, preserves count, rejects A and accepts B", async () => {
    const owner = Keypair.generate();
    const agentA = Keypair.generate();
    const candidateB = Keypair.generate();
    const slots = restartableSlots(agentA, candidateB);
    await slots.initial.generateActive();
    await slots.initial.generateCandidate();
    await fund(agentA.publicKey);
    const { vault, heartbeat } = await initialize(
      owner,
      agentA.publicKey
    );
    const beforeVault =
      await program.account.vaultConfig.fetch(vault);
    const beforeHeartbeat =
      await program.account.heartbeatRecord.fetch(heartbeat);
    const { transaction, blockhash, candidateSignature } =
      await buildDualSignedRotation(
        owner,
        candidateB,
        vault,
        heartbeat
      );

    const signature = await connection.sendRawTransaction(
      transaction.serialize()
    );
    expect(signature).to.equal(bs58.encode(candidateSignature));
    await connection.confirmTransaction(
      { signature, ...blockhash },
      "confirmed"
    );

    const afterVault =
      await program.account.vaultConfig.fetch(vault);
    const afterRotation =
      await program.account.heartbeatRecord.fetch(heartbeat);
    expect(afterVault.agentPubkey.equals(candidateB.publicKey)).to.equal(
      true
    );
    expect(afterVault.updatedAt.gte(beforeVault.updatedAt)).to.equal(
      true
    );
    expect(
      afterRotation.lastHeartbeat.gte(beforeHeartbeat.lastHeartbeat)
    ).to.equal(true);
    expect(
      afterRotation.totalHeartbeats.eq(
        beforeHeartbeat.totalHeartbeats
      )
    ).to.equal(true);

    // Simulate process restart over the same secure-slot storage. Canonical
    // chain authority selects B from the candidate slot before promotion.
    const afterRestart = createAgentKeySlotManager(slots.storage);
    expect(
      (
        await afterRestart.resolveForOnChainPublicKey(
          afterVault.agentPubkey.toBase58()
        )
      ).status
    ).to.equal("candidate_match");
    await afterRestart.promoteCandidate(
      agentA.publicKey.toBase58(),
      candidateB.publicKey.toBase58()
    );
    const afterPromotionRestart = createAgentKeySlotManager(
      slots.storage
    );
    expect(
      (
        await afterPromotionRestart.resolveForOnChainPublicKey(
          afterVault.agentPubkey.toBase58()
        )
      ).status
    ).to.equal("active_match");
    expect(
      (
        await afterPromotionRestart.resolveForOnChainPublicKey(
          agentA.publicKey.toBase58()
        )
      ).status
    ).to.equal("previous_match");

    try {
      await program.methods
        .recordHeartbeat({ activeTap: {} })
        .accountsPartial({
          agent: agentA.publicKey,
          vaultConfig: vault,
          heartbeatRecord: heartbeat,
        })
        .signers([agentA])
        .rpc();
      expect.fail("old agent heartbeat should fail");
    } catch (error) {
      expect(String(error)).to.include("UnauthorizedAgent");
    }
    await program.methods
      .recordHeartbeat({ activeTap: {} })
      .accountsPartial({
        agent: candidateB.publicKey,
        vaultConfig: vault,
        heartbeatRecord: heartbeat,
      })
      .signers([candidateB])
      .rpc();
    const afterHeartbeat =
      await program.account.heartbeatRecord.fetch(heartbeat);
    expect(
      afterHeartbeat.totalHeartbeats.eq(
        beforeHeartbeat.totalHeartbeats.add(new BN(1))
      )
    ).to.equal(true);
  });

  it("failed rotation retains A and rotation at the exact protocol deadline is frozen", async () => {
    const owner = Keypair.generate();
    const agentA = Keypair.generate();
    const candidateB = Keypair.generate();
    const { vault, heartbeat } = await initialize(
      owner,
      agentA.publicKey,
      10,
      30
    );
    const heartbeatBefore =
      await program.account.heartbeatRecord.fetch(heartbeat);
    const finalDeadline =
      heartbeatBefore.lastHeartbeat.toNumber() + 10 + 30;

    for (;;) {
      const slot = await connection.getSlot("confirmed");
      const chainTime = await connection.getBlockTime(slot);
      if (chainTime !== null && chainTime >= finalDeadline) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const { transaction } = await buildDualSignedRotation(
      owner,
      candidateB,
      vault,
      heartbeat
    );
    try {
      await connection.sendRawTransaction(transaction.serialize());
      expect.fail("post-deadline rotation should fail");
    } catch (error) {
      expect(String(error)).to.include("VaultFrozen");
    }
    const afterFailure =
      await program.account.vaultConfig.fetch(vault);
    expect(afterFailure.agentPubkey.equals(agentA.publicKey)).to.equal(
      true
    );
  });
});
