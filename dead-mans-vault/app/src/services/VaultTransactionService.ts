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
   * Tries Anchor deserialization first, falls back to raw byte parsing
   * if Anchor fails (e.g. Hermes runtime compatibility issues).
   */
  async fetchVaultConfig(owner: PublicKey): Promise<any | null> {
    const [pda] = this.getVaultPDA(owner);

    // Try Anchor deserialization first
    try {
      const readonlyWallet = {
        publicKey: owner,
        signTransaction: async (tx: Transaction) => tx,
        signAllTransactions: async (txs: Transaction[]) => txs,
      };
      const provider = new AnchorProvider(this.connection, readonlyWallet as any, {
        commitment: 'confirmed',
      });
      const program = new Program<DeadMansVault>(idl as any, provider);
      return await program.account.vaultConfig.fetch(pda);
    } catch {
      // Anchor deserialization failed — try raw fallback
    }

    // Raw byte parsing fallback
    try {
      const rawAccount = await this.connection.getAccountInfo(pda);
      if (!rawAccount || rawAccount.data.length < 92) return null;
      return VaultTransactionService.parseVaultConfigRaw(rawAccount.data);
    } catch {
      return null;
    }
  }

  /**
   * Parses VaultConfig from raw account bytes.
   * Layout: 8 discriminator | 32 owner | 32 agent | 8 interval | 8 grace |
   *         4 vec_len | N*(32+2+1) beneficiaries | 1 executed | 1 active |
   *         8 created_at | 8 updated_at | 1 bump | 1 is_mutable
   */
  static parseVaultConfigRaw(data: Buffer): any {
    let offset = 8; // skip discriminator

    const owner = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
    const agentPubkey = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
    const heartbeatInterval = new BN(data.subarray(offset, offset + 8), 'le'); offset += 8;
    const gracePeriod = new BN(data.subarray(offset, offset + 8), 'le'); offset += 8;

    const beneficiaryCount = data.readUInt32LE(offset); offset += 4;
    const beneficiaries: { wallet: PublicKey; shareBps: number; hasSpecificAssets: boolean }[] = [];
    for (let i = 0; i < beneficiaryCount && i < 20; i++) {
      const wallet = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
      const shareBps = data.readUInt16LE(offset); offset += 2;
      const hasSpecificAssets = data[offset] !== 0; offset += 1;
      beneficiaries.push({ wallet, shareBps, hasSpecificAssets });
    }

    const executed = data[offset] !== 0; offset += 1;
    const active = data[offset] !== 0; offset += 1;
    const createdAt = new BN(data.subarray(offset, offset + 8), 'le'); offset += 8;
    const updatedAt = new BN(data.subarray(offset, offset + 8), 'le'); offset += 8;
    const bump = data[offset]; offset += 1;
    const isMutable = data[offset] !== 0; offset += 1;

    return {
      owner, agentPubkey, heartbeatInterval, gracePeriod,
      beneficiaries, executed, active, createdAt, updatedAt,
      bump, isMutable,
    };
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
