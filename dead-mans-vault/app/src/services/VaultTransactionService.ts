import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
  getAccount,
} from '@solana/spl-token';
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

  async closeExecutedVault(
    agentKeypair: Keypair,
    ownerPubkey: PublicKey,
  ): Promise<string> {
    const program = this.getProgram(agentKeypair);
    const [vaultPda] = this.getVaultPDA(ownerPubkey);
    const [heartbeatPda] = this.getHeartbeatPDA(vaultPda);
    const [executionPda] = this.getExecutionPDA(vaultPda);

    const tx = await program.methods
      .closeExecutedVault()
      .accountsPartial({
        agent: agentKeypair.publicKey,
        owner: ownerPubkey,
        vaultConfig: vaultPda,
        heartbeatRecord: heartbeatPda,
        executionLog: executionPda,
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

  /**
   * Fetch the on-chain execution deadline: last_heartbeat + heartbeat_interval + grace_period.
   * Returns the Unix timestamp after which on-chain execution instructions will be accepted.
   * Returns null if accounts can't be read.
   */
  async getOnChainDeadline(owner: PublicKey): Promise<number | null> {
    const [vaultPda] = this.getVaultPDA(owner);
    const [heartbeatPda] = this.getHeartbeatPDA(vaultPda);

    try {
      const [vaultInfo, hbInfo] = await Promise.all([
        this.connection.getAccountInfo(vaultPda),
        this.connection.getAccountInfo(heartbeatPda),
      ]);
      if (!vaultInfo || !hbInfo) return null;

      // Parse heartbeat_interval and grace_period from VaultConfig
      // Layout: 8 disc | 32 owner | 32 agent | 8 interval | 8 grace ...
      const interval = Number(new BN(vaultInfo.data.subarray(72, 80), 'le'));
      const grace = Number(new BN(vaultInfo.data.subarray(80, 88), 'le'));

      // Parse last_heartbeat from HeartbeatRecord
      // Layout: 8 disc | 32 vault | 8 last_heartbeat ...
      const lastHeartbeat = Number(new BN(hbInfo.data.subarray(40, 48), 'le'));

      return lastHeartbeat + interval + grace;
    } catch {
      return null;
    }
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

  /**
   * Atomic close-then-reinit for an executed vault: closes VaultConfig,
   * HeartbeatRecord, and ExecutionLog PDAs, then re-initializes the vault.
   * Single MWA approval required.
   */
  async buildCloseExecutedAndReinitVaultTx(
    owner: PublicKey,
    agentPubkey: PublicKey,
    heartbeatInterval: number,
    gracePeriod: number,
    beneficiaries: { wallet: PublicKey; shareBps: number; hasSpecificAssets: boolean }[],
    isMutable: boolean = true,
  ): Promise<Transaction> {
    const [vaultPda] = this.getVaultPDA(owner);
    const [heartbeatPda] = this.getHeartbeatPDA(vaultPda);
    const [executionPda] = this.getExecutionPDA(vaultPda);

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
      .closeExecutedVaultByOwner()
      .accountsPartial({
        owner,
        vaultConfig: vaultPda,
        heartbeatRecord: heartbeatPda,
        executionLog: executionPda,
      })
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
    return this.addPriorityFee(tx, [owner, vaultPda, heartbeatPda, executionPda], 400_000);
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

  async buildDepositTokenTx(
    owner: PublicKey,
    mint: PublicKey,
    rawAmount: number,
  ): Promise<Transaction> {
    const [vaultPda] = this.getVaultPDA(owner);
    const ownerAta = await getAssociatedTokenAddress(mint, owner);
    const vaultAta = await getAssociatedTokenAddress(mint, vaultPda, true);

    const tx = new Transaction();

    // Create vault PDA's ATA if it doesn't exist
    try {
      await getAccount(this.connection, vaultAta);
    } catch {
      tx.add(
        createAssociatedTokenAccountInstruction(owner, vaultAta, vaultPda, mint),
      );
    }

    tx.add(createTransferInstruction(ownerAta, vaultAta, owner, rawAmount));

    return this.addPriorityFee(tx, [owner, vaultPda, mint], 120_000);
  }

  async buildWithdrawTokenTx(
    owner: PublicKey,
    mint: PublicKey,
    amount: number,
  ): Promise<Transaction> {
    const [vaultPda] = this.getVaultPDA(owner);
    const ownerAta = await getAssociatedTokenAddress(mint, owner);
    const vaultAta = await getAssociatedTokenAddress(mint, vaultPda, true);

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
      .withdrawFromVault(new BN(amount))
      .accountsPartial({
        owner,
        vaultConfig: vaultPda,
        sourceTokenAccount: vaultAta,
        destinationTokenAccount: ownerAta,
        vaultAuthority: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .transaction();

    return this.addPriorityFee(tx, [owner, vaultPda, mint], 120_000);
  }

  async buildWithdrawSolTx(
    owner: PublicKey,
    amountLamports: number,
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
      .withdrawSolFromVault(new BN(amountLamports))
      .accountsPartial({
        owner,
        vaultConfig: vaultPda,
      })
      .transaction();

    return this.addPriorityFee(tx, [owner, vaultPda], 120_000);
  }

  async executeSplDistribution(
    agentKeypair: Keypair,
    ownerPubkey: PublicKey,
    beneficiaryWallet: PublicKey,
    mint: PublicKey,
    amount: BN,
  ): Promise<string> {
    const program = this.getProgram(agentKeypair);
    const [vaultPda] = this.getVaultPDA(ownerPubkey);
    const [heartbeatPda] = this.getHeartbeatPDA(vaultPda);

    const sourceAta = await getAssociatedTokenAddress(mint, vaultPda, true);
    const destAta = await getAssociatedTokenAddress(mint, beneficiaryWallet);

    const tx = new Transaction();

    // Create beneficiary's ATA if it doesn't exist (agent pays)
    try {
      await getAccount(this.connection, destAta);
    } catch {
      tx.add(
        createAssociatedTokenAccountInstruction(
          agentKeypair.publicKey, destAta, beneficiaryWallet, mint,
        ),
      );
    }

    const distIx = await program.methods
      .executeDistribution(amount, new Array(32).fill(0))
      .accountsPartial({
        agent: agentKeypair.publicKey,
        vaultConfig: vaultPda,
        heartbeatRecord: heartbeatPda,
        sourceTokenAccount: sourceAta,
        destinationTokenAccount: destAta,
        vaultAuthority: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    tx.add(distIx);

    const priorityTx = await this.addPriorityFee(tx, [
      vaultPda, heartbeatPda, agentKeypair.publicKey, sourceAta, destAta,
    ], 200_000);

    priorityTx.feePayer = agentKeypair.publicKey;
    const { blockhash } = await this.connection.getLatestBlockhash();
    priorityTx.recentBlockhash = blockhash;

    return sendAndConfirmTransaction(this.connection, priorityTx, [agentKeypair], {
      commitment: 'confirmed',
      maxRetries: 3,
    });
  }

  async getVaultTokenBalances(vaultPda: PublicKey): Promise<{
    mint: PublicKey;
    amount: number;
    decimals: number;
    uiAmount: number;
  }[]> {
    const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
      vaultPda,
      { programId: TOKEN_PROGRAM_ID },
    );

    return tokenAccounts.value
      .map(({ account }) => {
        const parsed = account.data.parsed?.info;
        if (!parsed) return null;
        const tokenAmount = parsed.tokenAmount;
        if (Number(tokenAmount.amount) <= 0) return null;
        return {
          mint: new PublicKey(parsed.mint),
          amount: Number(tokenAmount.amount),
          decimals: tokenAmount.decimals,
          uiAmount: Number(tokenAmount.uiAmountString),
        };
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);
  }

  /**
   * Build individual instructions to withdraw ALL assets from the vault PDA.
   * Returns [splWithdrawIxs, solWithdrawIx?] — caller packs into transactions.
   */
  async buildWithdrawAllInstructions(
    owner: PublicKey,
  ): Promise<{ instructions: TransactionInstruction[]; assetCount: number }> {
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

    const instructions: TransactionInstruction[] = [];
    let assetCount = 0;

    // SPL token withdrawals
    const vaultTokens = await this.getVaultTokenBalances(vaultPda);
    for (const token of vaultTokens) {
      const ownerAta = await getAssociatedTokenAddress(token.mint, owner);
      const vaultAta = await getAssociatedTokenAddress(token.mint, vaultPda, true);

      // Create owner's ATA if it doesn't exist
      try {
        await getAccount(this.connection, ownerAta);
      } catch {
        instructions.push(
          createAssociatedTokenAccountInstruction(owner, ownerAta, owner, token.mint),
        );
      }

      const ix = await program.methods
        .withdrawFromVault(new BN(token.amount))
        .accountsPartial({
          owner,
          vaultConfig: vaultPda,
          sourceTokenAccount: vaultAta,
          destinationTokenAccount: ownerAta,
          vaultAuthority: vaultPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();
      instructions.push(ix);
      assetCount++;
    }

    // SOL withdrawal (above rent exemption)
    const vaultInfo = await this.connection.getAccountInfo(vaultPda);
    if (vaultInfo) {
      const rent = await this.connection.getMinimumBalanceForRentExemption(vaultInfo.data.length);
      const availableSol = vaultInfo.lamports - rent;
      if (availableSol > 0) {
        const ix = await program.methods
          .withdrawSolFromVault(new BN(availableSol))
          .accountsPartial({
            owner,
            vaultConfig: vaultPda,
          })
          .instruction();
        instructions.push(ix);
        assetCount++;
      }
    }

    return { instructions, assetCount };
  }

  /**
   * Pack withdrawal instructions (and optionally revoke) into minimal transactions.
   * ~8 withdraw instructions fit per TX within the 1232-byte limit.
   */
  async buildBatchedTxs(
    owner: PublicKey,
    withdrawIxs: TransactionInstruction[],
    options?: { includeRevoke?: boolean },
  ): Promise<Transaction[]> {
    const MAX_IXS_PER_TX = 8;
    const [vaultPda] = this.getVaultPDA(owner);

    // Split withdrawal instructions into chunks
    const chunks: TransactionInstruction[][] = [];
    for (let i = 0; i < withdrawIxs.length; i += MAX_IXS_PER_TX) {
      chunks.push(withdrawIxs.slice(i, i + MAX_IXS_PER_TX));
    }

    // If no withdrawals but revoke requested, create an empty chunk
    if (chunks.length === 0 && options?.includeRevoke) {
      chunks.push([]);
    }

    // Append revoke instruction to the last chunk
    if (options?.includeRevoke && chunks.length > 0) {
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

      const revokeIx = await program.methods
        .revokeVault()
        .accountsPartial({
          owner,
          vaultConfig: vaultPda,
          heartbeatRecord: heartbeatPda,
        })
        .instruction();
      chunks[chunks.length - 1].push(revokeIx);
    }

    // Build transactions from chunks
    const txs: Transaction[] = [];
    for (const chunk of chunks) {
      const tx = new Transaction();
      for (const ix of chunk) {
        tx.add(ix);
      }
      // CU estimate: 30k per instruction + 50k base
      const cuLimit = 50_000 + chunk.length * 30_000;
      const priorityTx = await this.addPriorityFee(tx, [owner, vaultPda], cuLimit);
      txs.push(priorityTx);
    }

    return txs;
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
