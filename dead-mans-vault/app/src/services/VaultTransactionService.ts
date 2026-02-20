import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  SystemProgram,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { Program, AnchorProvider, BN } from '@coral-xyz/anchor';
import { idl, DeadMansVault } from '../utils/idl';
import { PROGRAM_ID, RPC_URL, HELIUS_API_KEY } from '../utils/constants';
import { rpcWithRetry } from '../utils/fetchWithRetry';
import type { PriorityFeeEstimateResult } from '../types/api';

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

  /**
   * Estimate priority fee using Helius getPriorityFeeEstimate.
   * Falls back to a safe default (1000 micro-lamports) if estimation fails.
   */
  private async estimatePriorityFee(accountKeys: PublicKey[]): Promise<number> {
    // getPriorityFeeEstimate is Helius-only — skip retries when using standard RPC
    if (!HELIUS_API_KEY) return 1000;

    try {
      const result = await rpcWithRetry<PriorityFeeEstimateResult>(
        RPC_URL,
        'getPriorityFeeEstimate',
        [{
          accountKeys: accountKeys.map((k) => k.toString()),
          options: { recommended: true },
        }],
      );
      return result?.priorityFeeEstimate ?? 1000;
    } catch {
      return 1000; // Safe default: 1000 micro-lamports
    }
  }

  /**
   * Prepend ComputeBudget instructions for priority fee to a transaction.
   * CU limits tuned per instruction type to minimize fee cost.
   */
  private async addPriorityFee(
    tx: Transaction,
    accountKeys: PublicKey[],
    cuLimit: number = 200_000,
  ): Promise<Transaction> {
    const fee = await this.estimatePriorityFee(accountKeys);

    const priorityTx = new Transaction();
    priorityTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
    priorityTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: fee }));

    // Append original instructions
    for (const ix of tx.instructions) {
      priorityTx.add(ix);
    }

    return priorityTx;
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

    // Add priority fee for reliable landing (owner pays via MWA)
    return this.addPriorityFee(tx, [owner, vaultPda, heartbeatPda], 250_000);
  }

  async executeDistribution(
    agentKeypair: Keypair,
    ownerPubkey: PublicKey,
    beneficiaryWallet: PublicKey,
    amountLamports: BN,
  ): Promise<string> {
    const program = this.getProgram(agentKeypair);
    const [vaultPda] = this.getVaultPDA(ownerPubkey);
    const [heartbeatPda] = this.getHeartbeatPDA(vaultPda);

    // Build transaction (don't send yet — need to add priority fee)
    const tx = await program.methods
      .executeSolDistribution(amountLamports)
      .accountsPartial({
        agent: agentKeypair.publicKey,
        vaultConfig: vaultPda,
        heartbeatRecord: heartbeatPda,
        beneficiary: beneficiaryWallet,
      })
      .transaction();

    // Add priority fee — 150k CU for SOL distribution
    const priorityTx = await this.addPriorityFee(tx, [
      vaultPda, heartbeatPda, agentKeypair.publicKey, beneficiaryWallet,
    ], 150_000);

    priorityTx.feePayer = agentKeypair.publicKey;
    const { blockhash } = await this.connection.getLatestBlockhash();
    priorityTx.recentBlockhash = blockhash;

    const sig = await sendAndConfirmTransaction(this.connection, priorityTx, [agentKeypair], {
      commitment: 'confirmed',
      maxRetries: 3,
    });

    return sig;
  }

  async recordExecution(
    agentKeypair: Keypair,
    ownerPubkey: PublicKey,
    params: {
      transferCount: number;
      totalSolDistributed: BN;
      tokenTypesDistributed: number;
      attestationHash: number[];
      completed: boolean;
    },
  ): Promise<string> {
    const program = this.getProgram(agentKeypair);
    const [vaultPda] = this.getVaultPDA(ownerPubkey);
    const [heartbeatPda] = this.getHeartbeatPDA(vaultPda);
    const [executionPda] = this.getExecutionPDA(vaultPda);

    const tx = await program.methods
      .recordExecution({
        transferCount: params.transferCount,
        totalSolDistributed: params.totalSolDistributed,
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
      .transaction();

    const priorityTx = await this.addPriorityFee(tx, [
      vaultPda, heartbeatPda, executionPda, agentKeypair.publicKey,
    ]);

    priorityTx.feePayer = agentKeypair.publicKey;
    const { blockhash } = await this.connection.getLatestBlockhash();
    priorityTx.recentBlockhash = blockhash;

    const sig = await sendAndConfirmTransaction(this.connection, priorityTx, [agentKeypair], {
      commitment: 'confirmed',
      maxRetries: 3,
    });

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

    const tx = await program.methods
      .recordHeartbeat(methodEnum as any)
      .accountsPartial({
        agent: agentKeypair.publicKey,
        vaultConfig: vaultPda,
        heartbeatRecord: heartbeatPda,
      })
      .transaction();

    // 80k CU for heartbeat (lightweight state update)
    const priorityTx = await this.addPriorityFee(tx, [
      vaultPda, heartbeatPda, agentKeypair.publicKey,
    ], 80_000);

    priorityTx.feePayer = agentKeypair.publicKey;
    const { blockhash } = await this.connection.getLatestBlockhash();
    priorityTx.recentBlockhash = blockhash;

    const sig = await sendAndConfirmTransaction(this.connection, priorityTx, [agentKeypair], {
      commitment: 'confirmed',
      maxRetries: 3,
    });

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
      .revokeVault()
      .accountsPartial({
        owner,
        vaultConfig: vaultPda,
        heartbeatRecord: heartbeatPda,
      })
      .transaction();

    return this.addPriorityFee(tx, [owner, vaultPda, heartbeatPda], 120_000);
  }

  async buildCloseRevokedVaultTx(owner: PublicKey): Promise<Transaction> {
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
      .closeRevokedVault()
      .accountsPartial({
        owner,
        vaultConfig: vaultPda,
        heartbeatRecord: heartbeatPda,
      })
      .transaction();

    return this.addPriorityFee(tx, [owner, vaultPda, heartbeatPda], 100_000);
  }

  /**
   * Atomic close-then-reinit: closes a revoked zombie vault and re-initializes
   * in a single transaction. If either instruction fails, the entire tx reverts.
   * Single MWA approval required.
   */
  async buildCloseAndReinitVaultTx(
    owner: PublicKey,
    agentPubkey: PublicKey,
    heartbeatInterval: number,
    gracePeriod: number,
    beneficiaries: { wallet: PublicKey; shareBps: number; hasSpecificAssets: boolean }[],
    isMutable: boolean = true,
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

    const closeIx = await program.methods
      .closeRevokedVault()
      .accountsPartial({ owner, vaultConfig: vaultPda, heartbeatRecord: heartbeatPda })
      .instruction();

    const initIx = await program.methods
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
      .instruction();

    const tx = new Transaction().add(closeIx, initIx);
    return this.addPriorityFee(tx, [owner, vaultPda, heartbeatPda], 350_000);
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

    return this.addPriorityFee(tx, [owner, vaultPda], 120_000);
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
    return this.addPriorityFee(tx, [owner, vaultPda], 80_000);
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

    return this.addPriorityFee(tx, [owner, vaultPda, heartbeatPda], 100_000);
  }
}
