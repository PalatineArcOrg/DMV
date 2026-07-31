import * as anchor from '@coral-xyz/anchor';
import { BN, Program } from '@coral-xyz/anchor';
import { expect } from 'chai';
import { DeadMansVault } from '../target/types/dead_mans_vault';
import {
  createAgentKeySlotManager,
  type AgentKeySlotStorage,
} from '../app/src/tee/AgentKeySlotManagerCore';

const { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } = anchor.web3;

const FEE_WALLET = new PublicKey(
  '98x9Rn63Ne8xbL3w522zgbuYg9bdHn7cRqJQVCUZUFsp'
);

describe('WP 4.8 disposable side-by-side signing migration', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.deadMansVault as Program<DeadMansVault>;
  const connection = provider.connection;

  async function fund(publicKey: anchor.web3.PublicKey) {
    const signature = await connection.requestAirdrop(
      publicKey,
      LAMPORTS_PER_SOL
    );
    const blockhash = await connection.getLatestBlockhash('confirmed');
    await connection.confirmTransaction(
      { signature, ...blockhash },
      'confirmed'
    );
  }

  before(async () => {
    await fund(provider.wallet.publicKey);
  });

  function pdas(owner: anchor.web3.PublicKey) {
    const [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault'), owner.toBuffer()],
      program.programId
    );
    const [heartbeat] = PublicKey.findProgramAddressSync(
      [Buffer.from('heartbeat'), vault.toBuffer()],
      program.programId
    );
    return { vault, heartbeat };
  }

  function isolatedStorage() {
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
    return { values, storage };
  }

  async function rotate(
    owner: anchor.web3.Keypair,
    replacement: anchor.web3.Keypair,
    vault: anchor.web3.PublicKey,
    heartbeat: anchor.web3.PublicKey
  ) {
    const transaction = await program.methods
      .rotateAgent(replacement.publicKey)
      .accountsPartial({
        owner: owner.publicKey,
        vaultConfig: vault,
        heartbeatRecord: heartbeat,
      })
      .transaction();
    transaction.feePayer = replacement.publicKey;
    const blockhash = await connection.getLatestBlockhash('confirmed');
    transaction.recentBlockhash = blockhash.blockhash;
    transaction.partialSign(replacement);
    const replacementSignature = Buffer.from(transaction.signature!);
    transaction.partialSign(owner);
    expect(transaction.verifySignatures()).to.equal(true);
    expect(
      transaction.signatures[0].publicKey.equals(replacement.publicKey)
    ).to.equal(true);
    expect(Buffer.from(transaction.signature!)).to.deep.equal(
      replacementSignature
    );
    const signature = await connection.sendRawTransaction(
      transaction.serialize()
    );
    await connection.confirmTransaction(
      { signature, ...blockhash },
      'confirmed'
    );
    return signature;
  }

  it('rotates A to isolated successor B, proves B heartbeat, and deliberately rolls back to retained A', async () => {
    const owner = Keypair.generate();
    const legacyAgentA = Keypair.generate();
    const successorAgentB = Keypair.generate();
    const successorPublicKey = successorAgentB.publicKey;
    await Promise.all([
      fund(owner.publicKey),
      fund(legacyAgentA.publicKey),
      fund(successorAgentB.publicKey),
    ]);

    const legacyStorage = isolatedStorage();
    const successorStorage = isolatedStorage();
    const bridge = createAgentKeySlotManager(
      legacyStorage.storage,
      () => legacyAgentA
    );
    const successor = createAgentKeySlotManager(
      successorStorage.storage,
      () => successorAgentB
    );
    await bridge.generateActive();
    expect(await successor.getPublicKey('active')).to.equal(null);
    await successor.generateCandidate();

    const { vault, heartbeat } = pdas(owner.publicKey);
    try {
      await program.methods
        .initializeVault({
          agentPubkey: legacyAgentA.publicKey,
          heartbeatInterval: new BN(100),
          gracePeriod: new BN(100),
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
    } catch (error) {
      throw new Error(`initialize failed: ${String(error)}`);
    }

    const before = await program.account.heartbeatRecord.fetch(heartbeat);
    await rotate(owner, successorAgentB, vault, heartbeat);
    const afterRotation = await program.account.heartbeatRecord.fetch(
      heartbeat
    );
    const vaultWithB = await program.account.vaultConfig.fetch(vault);
    expect(vaultWithB.agentPubkey.equals(successorAgentB.publicKey)).to.equal(
      true
    );
    expect(afterRotation.totalHeartbeats.eq(before.totalHeartbeats)).to.equal(
      true
    );

    await successor.promoteIncomingCandidate(
      legacyAgentA.publicKey.toBase58(),
      successorAgentB.publicKey.toBase58()
    );
    const successorAfterRestart = createAgentKeySlotManager(
      successorStorage.storage
    );
    expect(
      (
        await successorAfterRestart.resolveForOnChainPublicKey(
          successorPublicKey.toBase58()
        )
      ).status
    ).to.equal('active_match');
    const successorActive = await successorAfterRestart.loadSlot('active');

    try {
      await program.methods
        .recordHeartbeat({ activeTap: {} })
        .accountsPartial({
          agent: successorPublicKey,
          vaultConfig: vault,
          heartbeatRecord: heartbeat,
        })
        .signers([successorActive])
        .rpc();
    } catch (error) {
      throw new Error(`successor heartbeat failed: ${String(error)}`);
    }
    const afterSuccessorHeartbeat = await program.account.heartbeatRecord.fetch(
      heartbeat
    );
    expect(
      afterSuccessorHeartbeat.totalHeartbeats.eq(
        before.totalHeartbeats.add(new BN(1))
      )
    ).to.equal(true);

    try {
      await program.methods
        .recordHeartbeat({ activeTap: {} })
        .accountsPartial({
          agent: legacyAgentA.publicKey,
          vaultConfig: vault,
          heartbeatRecord: heartbeat,
        })
        .signers([legacyAgentA])
        .rpc();
      expect.fail('legacy bridge heartbeat should be blocked');
    } catch (error) {
      expect(String(error)).to.include('UnauthorizedAgent');
    }

    // Emergency rollback uses the retained bridge key as replacement payer
    // plus the owner instruction signature. It never needs B's secret.
    await rotate(owner, legacyAgentA, vault, heartbeat);
    const vaultWithA = await program.account.vaultConfig.fetch(vault);
    expect(vaultWithA.agentPubkey.equals(legacyAgentA.publicKey)).to.equal(
      true
    );
    try {
      await program.methods
        .recordHeartbeat({ activeTap: {} })
        .accountsPartial({
          agent: legacyAgentA.publicKey,
          vaultConfig: vault,
          heartbeatRecord: heartbeat,
        })
        .signers([legacyAgentA])
        .rpc();
    } catch (error) {
      throw new Error(`rollback heartbeat failed: ${String(error)}`);
    }

    expect(successorStorage.values.get('dmv_agent_public_key')).to.equal(
      successorPublicKey.toBase58()
    );
    expect(legacyStorage.values.get('dmv_agent_public_key')).to.equal(
      legacyAgentA.publicKey.toBase58()
    );
    expect(successorStorage.values).to.not.equal(legacyStorage.values);
  });
});
