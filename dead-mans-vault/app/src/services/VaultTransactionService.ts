import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { Program, AnchorProvider, BN } from '@coral-xyz/anchor';
import { idl, DeadMansVault } from '../utils/idl';
import { PROGRAM_ID, RPC_URL } from '../utils/constants';
import { Beneficiary } from '../types/vault';

const programId = new PublicKey(PROGRAM_ID);

export class VaultTransactionService {
  private connection: Connection;

  constructor() {
    this.connection = new Connection(RPC_URL, 'confirmed');
  }

  getConnection(): Connection {
    return this.connection;
  }

  getVaultPDA(owner: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('vault'), owner.toBuffer()],
      programId,
    );
  }

  getHeartbeatPDA(vaultConfig: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('heartbeat'), vaultConfig.toBuffer()],
      programId,
    );
  }

  getExecutionPDA(vaultConfig: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('execution'), vaultConfig.toBuffer()],
      programId,
    );
  }

  private getProgram(agentKeypair: Keypair): Program<DeadMansVault> {
    const wallet = {
      publicKey: agentKeypair.publicKey,
      signTransaction: async (tx: Transaction) => {
        tx.partialSign(agentKeypair);
        return tx;
      },
      signAllTransactions: async (txs: Transaction[]) => {
        txs.forEach((tx) => tx.partialSign(agentKeypair));
        return txs;
      },
    };
    const provider = new AnchorProvider(this.connection, wallet as any, {
      commitment: 'confirmed',
    });
    return new Program<DeadMansVault>(idl as any, provider);
  }

  async buildInitializeVaultTx(
    owner: PublicKey,
    agentPubkey: PublicKey,
    heartbeatInterval: number,
    gracePeriod: number,
    beneficiaries: { wallet: PublicKey; shareBps: number; hasSpecificAssets: boolean }[],
  ): Promise<Transaction> {
    const [vaultPda] = this.getVaultPDA(owner);
    const [heartbeatPda] = this.getHeartbeatPDA(vaultPda);

    // Build the instruction manually using the IDL
    const readonlyWallet = {
      publicKey: owner,
      signTransaction: async (tx: Transaction) => tx,
      signAllTransactions: async (txs: Transaction[]) => txs,
    };
    const provider = new AnchorProvider(this.connection, readonlyWallet as any, {
      commitment: 'confirmed',
    });
    const program = new Program<DeadMansVault>(idl as any, provider);

    const tx = await program.methods
      .initializeVault({
        agentPubkey,
        heartbeatInterval: new BN(heartbeatInterval),
        gracePeriod: new BN(gracePeriod),
        beneficiaries: beneficiaries.map((b) => ({
          wallet: b.wallet,
          shareBps: b.shareBps,
          hasSpecificAssets: b.hasSpecificAssets,
        })),
      })
      .accountsPartial({
        owner,
        vaultConfig: vaultPda,
        heartbeatRecord: heartbeatPda,
        systemProgram: SystemProgram.programId,
      })
      .transaction();

    return tx;
  }

  async executeDistribution(
    agentKeypair: Keypair,
    ownerPubkey: PublicKey,
    beneficiaryWallet: PublicKey,
    amountLamports: number,
  ): Promise<string> {
    // MVP: Direct SOL transfer via system program signed by agent
    // The agent must have been funded to pay for fees + the transfer
    // In practice, the vault owner's SOL is held in owner's account;
    // for MVP we demonstrate the flow with agent-signed system transfers
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: agentKeypair.publicKey,
        toPubkey: beneficiaryWallet,
        lamports: amountLamports,
      }),
    );

    tx.feePayer = agentKeypair.publicKey;
    tx.recentBlockhash = (
      await this.connection.getLatestBlockhash()
    ).blockhash;
    tx.partialSign(agentKeypair);

    // Note: In production, the owner would pre-delegate via token approvals.
    // For MVP hackathon demo, the agent key needs to hold the SOL being distributed.
    // We send from the agent's own balance to demonstrate the execution flow.
    const sig = await this.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
    });
    await this.connection.confirmTransaction(sig, 'confirmed');
    return sig;
  }

  async recordExecution(
    agentKeypair: Keypair,
    ownerPubkey: PublicKey,
    params: {
      transferCount: number;
      totalSolDistributed: number;
      tokenTypesDistributed: number;
      attestationHash: number[];
      completed: boolean;
    },
  ): Promise<string> {
    const program = this.getProgram(agentKeypair);
    const [vaultPda] = this.getVaultPDA(ownerPubkey);
    const [executionPda] = this.getExecutionPDA(vaultPda);

    const sig = await program.methods
      .recordExecution({
        transferCount: params.transferCount,
        totalSolDistributed: new BN(params.totalSolDistributed),
        tokenTypesDistributed: params.tokenTypesDistributed,
        attestationHash: params.attestationHash,
        completed: params.completed,
      })
      .accountsPartial({
        agent: agentKeypair.publicKey,
        payer: agentKeypair.publicKey,
        vaultConfig: vaultPda,
        executionLog: executionPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return sig;
  }

  async recordHeartbeatOnChain(
    agentKeypair: Keypair,
    ownerPubkey: PublicKey,
    method: 'activeTap' | 'biometricConfirm' | 'onChainActivity' | 'pinChallenge' | 'hardwareSwitch',
  ): Promise<string> {
    const program = this.getProgram(agentKeypair);
    const [vaultPda] = this.getVaultPDA(ownerPubkey);
    const [heartbeatPda] = this.getHeartbeatPDA(vaultPda);

    const methodEnum = { [method]: {} };

    const sig = await program.methods
      .recordHeartbeat(methodEnum as any)
      .accountsPartial({
        agent: agentKeypair.publicKey,
        vaultConfig: vaultPda,
        heartbeatRecord: heartbeatPda,
      })
      .rpc();

    return sig;
  }

  async fetchVaultConfig(owner: PublicKey): Promise<any | null> {
    const readonlyWallet = {
      publicKey: owner,
      signTransaction: async (tx: Transaction) => tx,
      signAllTransactions: async (txs: Transaction[]) => txs,
    };
    const provider = new AnchorProvider(this.connection, readonlyWallet as any, {
      commitment: 'confirmed',
    });
    const program = new Program<DeadMansVault>(idl as any, provider);

    const [pda] = this.getVaultPDA(owner);
    try {
      return await program.account.vaultConfig.fetch(pda);
    } catch {
      return null;
    }
  }

  async buildRevokeVaultTx(owner: PublicKey): Promise<Transaction> {
    const [vaultPda] = this.getVaultPDA(owner);

    const readonlyWallet = {
      publicKey: owner,
      signTransaction: async (tx: Transaction) => tx,
      signAllTransactions: async (txs: Transaction[]) => txs,
    };
    const provider = new AnchorProvider(this.connection, readonlyWallet as any, {
      commitment: 'confirmed',
    });
    const program = new Program<DeadMansVault>(idl as any, provider);

    const tx = await program.methods
      .revokeVault()
      .accountsPartial({
        owner,
        vaultConfig: vaultPda,
      })
      .transaction();

    return tx;
  }

  async buildRotateAgentTx(
    owner: PublicKey,
    newAgentPubkey: PublicKey,
  ): Promise<Transaction> {
    const [vaultPda] = this.getVaultPDA(owner);
    const [heartbeatPda] = this.getHeartbeatPDA(vaultPda);

    const readonlyWallet = {
      publicKey: owner,
      signTransaction: async (tx: Transaction) => tx,
      signAllTransactions: async (txs: Transaction[]) => txs,
    };
    const provider = new AnchorProvider(this.connection, readonlyWallet as any, {
      commitment: 'confirmed',
    });
    const program = new Program<DeadMansVault>(idl as any, provider);

    const tx = await program.methods
      .rotateAgent(newAgentPubkey)
      .accountsPartial({
        owner,
        vaultConfig: vaultPda,
        heartbeatRecord: heartbeatPda,
      })
      .transaction();

    return tx;
  }
}
