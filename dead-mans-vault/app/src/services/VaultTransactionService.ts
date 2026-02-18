import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  SystemProgram,
} from '@solana/web3.js';
import { Program, AnchorProvider, BN } from '@coral-xyz/anchor';
import { idl, DeadMansVault } from '../utils/idl';
import { PROGRAM_ID, RPC_URL } from '../utils/constants';

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
    isMutable: boolean = true,
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
        isMutable,
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
    // On-chain enforced SOL distribution from vault PDA to beneficiary.
    // The program verifies: vault active, not executed, agent authorized,
    // grace period elapsed, and beneficiary is in the whitelist.
    const program = this.getProgram(agentKeypair);
    const [vaultPda] = this.getVaultPDA(ownerPubkey);
    const [heartbeatPda] = this.getHeartbeatPDA(vaultPda);

    // accountsPartial() is used because Anchor's generated ResolvedAccounts
    // type requires every account including PDAs that are auto-derived.
    // accountsPartial() allows specifying only the accounts we pass explicitly.
    const sig = await program.methods
      .executeSolDistribution(new BN(amountLamports))
      .accountsPartial({
        agent: agentKeypair.publicKey,
        vaultConfig: vaultPda,
        heartbeatRecord: heartbeatPda,
        beneficiary: beneficiaryWallet,
      })
      .rpc();

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
    const [heartbeatPda] = this.getHeartbeatPDA(vaultPda);
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
        heartbeatRecord: heartbeatPda,
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

  /**
   * Fetches the on-chain VaultConfig account.
   * Returns Anchor-deserialized data where numeric fields (heartbeatInterval,
   * gracePeriod, createdAt, updatedAt) are BN instances, and beneficiaries
   * lack the client-side `label` field.
   */
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

  async buildUpdateVaultTx(
    owner: PublicKey,
    params: {
      heartbeatInterval?: number;
      gracePeriod?: number;
      beneficiaries?: { wallet: PublicKey; shareBps: number; hasSpecificAssets: boolean }[];
    },
  ): Promise<Transaction> {
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
      .updateVault({
        heartbeatInterval: params.heartbeatInterval ? new BN(params.heartbeatInterval) : null,
        gracePeriod: params.gracePeriod ? new BN(params.gracePeriod) : null,
        beneficiaries: params.beneficiaries
          ? params.beneficiaries.map((b) => ({
              wallet: b.wallet,
              shareBps: b.shareBps,
              hasSpecificAssets: b.hasSpecificAssets,
            }))
          : null,
      })
      .accountsPartial({
        owner,
        vaultConfig: vaultPda,
      })
      .transaction();

    return tx;
  }

  async buildFundVaultTx(
    owner: PublicKey,
    amountLamports: number,
  ): Promise<Transaction> {
    const [vaultPda] = this.getVaultPDA(owner);
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: owner,
        toPubkey: vaultPda,
        lamports: amountLamports,
      }),
    );
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
