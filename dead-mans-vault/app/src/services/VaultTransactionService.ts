import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
} from '@solana/spl-token';
import { Program, AnchorProvider, BN } from '@coral-xyz/anchor';
import { idl, DeadMansVault } from '../utils/idl';
import { PROGRAM_ID, RPC_URL, HELIUS_API_KEY, KEEPER_BOUNTY_LAMPORTS } from '../utils/constants';
import { rpcWithRetry } from '../utils/fetchWithRetry';
import type { PriorityFeeEstimateResult } from '../types/api';
import type { AssetAssignment } from '../types/vault';

const programId = new PublicKey(PROGRAM_ID);

/** On-chain beneficiary shape (UI Beneficiary carries extra display-only fields). */
type OnChainBeneficiary = { wallet: PublicKey; shareBps: number };

export class VaultTransactionService {
  private connection: Connection;

  constructor() {
    this.connection = new Connection(RPC_URL, 'confirmed');
  }

  getConnection(): Connection {
    return this.connection;
  }

  // ─── PDA helpers ───

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

  getAssetPlanPDA(vaultConfig: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('asset_plan'), vaultConfig.toBuffer()],
      programId,
    );
  }

  getTokenDistPDA(vaultConfig: PublicKey, mint: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('token_dist'), vaultConfig.toBuffer(), mint.toBuffer()],
      programId,
    );
  }

  // ─── Program providers ───

  /** Read-only program (no signer) for building instructions / fetching accounts. */
  private programAs(pubkey: PublicKey): Program<DeadMansVault> {
    const readonlyWallet = {
      publicKey: pubkey,
      signTransaction: async (tx: Transaction) => tx,
      signAllTransactions: async (txs: Transaction[]) => txs,
    };
    const provider = new AnchorProvider(this.connection, readonlyWallet as any, {
      commitment: 'confirmed',
    });
    return new Program<DeadMansVault>(idl as any, provider);
  }

  /** Program bound to a keypair wallet (used by the agent-signed heartbeat). */
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

  // ─── Token program / ATA helpers ───

  /** Detect whether a mint is owned by the Token or Token-2022 program. */
  async getTokenProgramForMint(mint: PublicKey): Promise<PublicKey> {
    const info = await this.connection.getAccountInfo(mint);
    if (info && info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
    return TOKEN_PROGRAM_ID;
  }

  private ataFor(
    mint: PublicKey,
    owner: PublicKey,
    allowOffCurve: boolean,
    tokenProgram: PublicKey,
  ): PublicKey {
    return getAssociatedTokenAddressSync(mint, owner, allowOffCurve, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID);
  }

  private static toOnChainBenef(b: { wallet: PublicKey; shareBps: number }): OnChainBeneficiary {
    return { wallet: b.wallet, shareBps: b.shareBps };
  }

  // ─── Priority fee ───

  private async estimatePriorityFee(accountKeys: PublicKey[]): Promise<number> {
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
      return 1000;
    }
  }

  private async addPriorityFee(
    tx: Transaction,
    accountKeys: PublicKey[],
    cuLimit: number = 200_000,
  ): Promise<Transaction> {
    const fee = await this.estimatePriorityFee(accountKeys);
    const priorityTx = new Transaction();
    priorityTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
    priorityTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: fee }));
    for (const ix of tx.instructions) {
      priorityTx.add(ix);
    }
    return priorityTx;
  }

  /**
   * Build a priority-fee-wrapped tx from instructions, sign with `payer` (+ any
   * extra signers), and send via sendRawTransaction (never sendAndConfirmTransaction
   * on mobile — its WebSocket subscription fails under React Native).
   */
  private async sendWithPayer(
    instructions: TransactionInstruction[],
    payer: Keypair,
    accountKeys: PublicKey[],
    cuLimit: number,
    extraSigners: Keypair[] = [],
  ): Promise<string> {
    const tx = new Transaction();
    for (const ix of instructions) tx.add(ix);
    const priorityTx = await this.addPriorityFee(tx, accountKeys, cuLimit);
    priorityTx.feePayer = payer.publicKey;
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
    priorityTx.recentBlockhash = blockhash;
    priorityTx.sign(payer, ...extraSigners);
    const sig = await this.connection.sendRawTransaction(priorityTx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    await this.connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      'confirmed',
    );
    return sig;
  }

  // ─── Vault setup / owner instructions ───

  async buildInitializeVaultTx(
    owner: PublicKey,
    agentPubkey: PublicKey,
    heartbeatInterval: number,
    gracePeriod: number,
    beneficiaries: { wallet: PublicKey; shareBps: number }[],
    isMutable: boolean = true,
  ): Promise<Transaction> {
    const [vaultPda] = this.getVaultPDA(owner);
    const [heartbeatPda] = this.getHeartbeatPDA(vaultPda);
    const program = this.programAs(owner);

    const tx = await program.methods
      .initializeVault({
        agentPubkey,
        heartbeatInterval: new BN(heartbeatInterval),
        gracePeriod: new BN(gracePeriod),
        beneficiaries: beneficiaries.map(VaultTransactionService.toOnChainBenef),
        isMutable,
        keeperBounty: new BN(KEEPER_BOUNTY_LAMPORTS),
      })
      .accountsPartial({
        owner,
        vaultConfig: vaultPda,
        heartbeatRecord: heartbeatPda,
        systemProgram: SystemProgram.programId,
      })
      .transaction();

    return this.addPriorityFee(tx, [owner, vaultPda, heartbeatPda], 250_000);
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

    const ix = await program.methods
      .recordHeartbeat(methodEnum as any)
      .accountsPartial({
        agent: agentKeypair.publicKey,
        vaultConfig: vaultPda,
        heartbeatRecord: heartbeatPda,
      })
      .instruction();

    return this.sendWithPayer([ix], agentKeypair, [vaultPda, heartbeatPda, agentKeypair.publicKey], 80_000);
  }

  async buildUpdateVaultTx(
    owner: PublicKey,
    params: {
      heartbeatInterval?: number;
      gracePeriod?: number;
      beneficiaries?: { wallet: PublicKey; shareBps: number }[];
    },
  ): Promise<Transaction> {
    const [vaultPda] = this.getVaultPDA(owner);
    const [heartbeatPda] = this.getHeartbeatPDA(vaultPda);
    const program = this.programAs(owner);

    const tx = await program.methods
      .updateVault({
        heartbeatInterval: params.heartbeatInterval ? new BN(params.heartbeatInterval) : null,
        gracePeriod: params.gracePeriod ? new BN(params.gracePeriod) : null,
        beneficiaries: params.beneficiaries
          ? params.beneficiaries.map(VaultTransactionService.toOnChainBenef)
          : null,
      })
      .accountsPartial({
        owner,
        vaultConfig: vaultPda,
        heartbeatRecord: heartbeatPda,
      })
      .transaction();

    return this.addPriorityFee(tx, [owner, vaultPda, heartbeatPda], 130_000);
  }

  async buildRevokeVaultTx(owner: PublicKey): Promise<Transaction> {
    const [vaultPda] = this.getVaultPDA(owner);
    const [heartbeatPda] = this.getHeartbeatPDA(vaultPda);
    const assetPlan = await this.assetPlanIfPresent(owner);
    const program = this.programAs(owner);

    const tx = await program.methods
      .revokeVault()
      .accountsPartial({
        owner,
        vaultConfig: vaultPda,
        heartbeatRecord: heartbeatPda,
        assetPlan,
      })
      .transaction();

    return this.addPriorityFee(tx, [owner, vaultPda, heartbeatPda], 130_000);
  }

  async buildCloseRevokedVaultTx(owner: PublicKey): Promise<Transaction> {
    const [vaultPda] = this.getVaultPDA(owner);
    const [heartbeatPda] = this.getHeartbeatPDA(vaultPda);
    const program = this.programAs(owner);

    const tx = await program.methods
      .closeRevokedVault()
      .accountsPartial({ owner, vaultConfig: vaultPda, heartbeatRecord: heartbeatPda })
      .transaction();

    return this.addPriorityFee(tx, [owner, vaultPda, heartbeatPda], 100_000);
  }

  /** Atomic close-then-reinit for a revoked zombie vault. Single MWA approval. */
  async buildCloseAndReinitVaultTx(
    owner: PublicKey,
    agentPubkey: PublicKey,
    heartbeatInterval: number,
    gracePeriod: number,
    beneficiaries: { wallet: PublicKey; shareBps: number }[],
    isMutable: boolean = true,
  ): Promise<Transaction> {
    const [vaultPda] = this.getVaultPDA(owner);
    const [heartbeatPda] = this.getHeartbeatPDA(vaultPda);
    const program = this.programAs(owner);

    const closeIx = await program.methods
      .closeRevokedVault()
      .accountsPartial({ owner, vaultConfig: vaultPda, heartbeatRecord: heartbeatPda })
      .instruction();

    const initIx = await program.methods
      .initializeVault({
        agentPubkey,
        heartbeatInterval: new BN(heartbeatInterval),
        gracePeriod: new BN(gracePeriod),
        beneficiaries: beneficiaries.map(VaultTransactionService.toOnChainBenef),
        isMutable,
        keeperBounty: new BN(KEEPER_BOUNTY_LAMPORTS),
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
   * Atomic close-then-reinit for an EXECUTED vault: closes core PDAs (and the
   * AssetPlan if present, sweeping any SOL dust to the largest-share beneficiary),
   * then re-initializes. Requires open_token_dists == 0 (all token dists closed).
   */
  async buildCloseExecutedAndReinitVaultTx(
    owner: PublicKey,
    agentPubkey: PublicKey,
    heartbeatInterval: number,
    gracePeriod: number,
    beneficiaries: { wallet: PublicKey; shareBps: number }[],
    isMutable: boolean = true,
  ): Promise<Transaction> {
    const [vaultPda] = this.getVaultPDA(owner);
    const [heartbeatPda] = this.getHeartbeatPDA(vaultPda);
    const [executionPda] = this.getExecutionPDA(vaultPda);
    const program = this.programAs(owner);

    // Read the OLD config to pin the AssetPlan + largest-share beneficiary (for
    // SOL dust) before it is closed.
    const oldConfig = await this.fetchVaultConfig(owner);
    const hasAssetPlan = !!oldConfig?.hasAssetPlan;
    const [assetPlanPda] = this.getAssetPlanPDA(vaultPda);
    const largestBenef = oldConfig?.beneficiaries?.length
      ? VaultTransactionService.largestShareWallet(oldConfig.beneficiaries)
      : null;

    const closeIx = await program.methods
      .closeExecutedVaultByOwner()
      .accountsPartial({
        owner,
        vaultConfig: vaultPda,
        heartbeatRecord: heartbeatPda,
        executionLog: executionPda,
        assetPlan: hasAssetPlan ? assetPlanPda : null,
        largestBenef,
      })
      .instruction();

    const initIx = await program.methods
      .initializeVault({
        agentPubkey,
        heartbeatInterval: new BN(heartbeatInterval),
        gracePeriod: new BN(gracePeriod),
        beneficiaries: beneficiaries.map(VaultTransactionService.toOnChainBenef),
        isMutable,
        keeperBounty: new BN(KEEPER_BOUNTY_LAMPORTS),
      })
      .accountsPartial({
        owner,
        vaultConfig: vaultPda,
        heartbeatRecord: heartbeatPda,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(closeIx, initIx);
    return this.addPriorityFee(tx, [owner, vaultPda, heartbeatPda, executionPda], 420_000);
  }

  /**
   * Close an EXECUTED vault's core PDAs (VaultConfig + HeartbeatRecord +
   * ExecutionLog, and the AssetPlan if present), reclaiming rent to the owner
   * and sweeping any SOL dust to the largest-share beneficiary. No reinit.
   * Requires open_token_dists == 0 (all token dists closed first).
   */
  async buildCloseExecutedVaultTx(owner: PublicKey): Promise<Transaction> {
    const [vaultPda] = this.getVaultPDA(owner);
    const [heartbeatPda] = this.getHeartbeatPDA(vaultPda);
    const [executionPda] = this.getExecutionPDA(vaultPda);
    const program = this.programAs(owner);

    // Pin the AssetPlan + largest-share beneficiary (for SOL dust) before close.
    const oldConfig = await this.fetchVaultConfig(owner);
    const hasAssetPlan = !!oldConfig?.hasAssetPlan;
    const [assetPlanPda] = this.getAssetPlanPDA(vaultPda);
    const largestBenef = oldConfig?.beneficiaries?.length
      ? VaultTransactionService.largestShareWallet(oldConfig.beneficiaries)
      : null;

    const closeIx = await program.methods
      .closeExecutedVaultByOwner()
      .accountsPartial({
        owner,
        vaultConfig: vaultPda,
        heartbeatRecord: heartbeatPda,
        executionLog: executionPda,
        assetPlan: hasAssetPlan ? assetPlanPda : null,
        largestBenef,
      })
      .instruction();

    const tx = new Transaction().add(closeIx);
    return this.addPriorityFee(tx, [owner, vaultPda, heartbeatPda, executionPda], 250_000);
  }

  async buildFundVaultTx(owner: PublicKey, amountLamports: number): Promise<Transaction> {
    const [vaultPda] = this.getVaultPDA(owner);
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: vaultPda, lamports: amountLamports }),
    );
    return this.addPriorityFee(tx, [owner, vaultPda], 80_000);
  }

  async buildDepositTokenTx(owner: PublicKey, mint: PublicKey, rawAmount: number): Promise<Transaction> {
    const [vaultPda] = this.getVaultPDA(owner);
    const tokenProgram = await this.getTokenProgramForMint(mint);
    const ownerAta = this.ataFor(mint, owner, false, tokenProgram);
    const vaultAta = this.ataFor(mint, vaultPda, true, tokenProgram);

    const tx = new Transaction();
    try {
      await getAccount(this.connection, vaultAta, 'confirmed', tokenProgram);
    } catch {
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(owner, vaultAta, vaultPda, mint, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID),
      );
    }
    tx.add(createTransferInstruction(ownerAta, vaultAta, owner, rawAmount, [], tokenProgram));
    return this.addPriorityFee(tx, [owner, vaultPda, mint], 120_000);
  }

  async buildWithdrawTokenTx(owner: PublicKey, mint: PublicKey, amount: number): Promise<Transaction> {
    const [vaultPda] = this.getVaultPDA(owner);
    const [heartbeatPda] = this.getHeartbeatPDA(vaultPda);
    const ownerAta = await getAssociatedTokenAddress(mint, owner);
    const vaultAta = await getAssociatedTokenAddress(mint, vaultPda, true);
    const program = this.programAs(owner);

    const tx = await program.methods
      .withdrawFromVault(new BN(amount))
      .accountsPartial({
        owner,
        vaultConfig: vaultPda,
        heartbeatRecord: heartbeatPda,
        sourceTokenAccount: vaultAta,
        destinationTokenAccount: ownerAta,
        vaultAuthority: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .transaction();

    return this.addPriorityFee(tx, [owner, vaultPda, mint], 130_000);
  }

  async buildWithdrawSolTx(owner: PublicKey, amountLamports: number): Promise<Transaction> {
    const [vaultPda] = this.getVaultPDA(owner);
    const [heartbeatPda] = this.getHeartbeatPDA(vaultPda);
    const program = this.programAs(owner);

    const tx = await program.methods
      .withdrawSolFromVault(new BN(amountLamports))
      .accountsPartial({
        owner,
        vaultConfig: vaultPda,
        heartbeatRecord: heartbeatPda,
      })
      .transaction();

    return this.addPriorityFee(tx, [owner, vaultPda, heartbeatPda], 130_000);
  }

  async buildRotateAgentTx(owner: PublicKey, newAgentPubkey: PublicKey): Promise<Transaction> {
    const [vaultPda] = this.getVaultPDA(owner);
    const [heartbeatPda] = this.getHeartbeatPDA(vaultPda);
    const program = this.programAs(owner);

    const tx = await program.methods
      .rotateAgent(newAgentPubkey)
      .accountsPartial({ owner, vaultConfig: vaultPda, heartbeatRecord: heartbeatPda })
      .transaction();

    return this.addPriorityFee(tx, [owner, vaultPda, heartbeatPda], 100_000);
  }

  /** Sweep the agent's remaining SOL (minus fee reserve) back to the owner. */
  async refundAgentSol(agentKeypair: Keypair, ownerPubkey: PublicKey): Promise<string | null> {
    const balance = await this.connection.getBalance(agentKeypair.publicKey, 'confirmed');
    const FEE_RESERVE = 5000;
    const refundAmount = balance - FEE_RESERVE;
    if (refundAmount <= 0) return null;

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: agentKeypair.publicKey,
        toPubkey: ownerPubkey,
        lamports: refundAmount,
      }),
    );
    tx.feePayer = agentKeypair.publicKey;
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.sign(agentKeypair);
    const sig = await this.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    await this.connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      'confirmed',
    );
    return sig;
  }

  // ─── Specific bequests (owner, MWA) ───

  async buildSetAssetPlanTx(owner: PublicKey, assignments: AssetAssignment[]): Promise<Transaction> {
    const [vaultPda] = this.getVaultPDA(owner);
    const [heartbeatPda] = this.getHeartbeatPDA(vaultPda);
    const [assetPlanPda] = this.getAssetPlanPDA(vaultPda);
    const program = this.programAs(owner);

    const tx = await program.methods
      .setAssetPlan(assignments.map(VaultTransactionService.toOnChainAssignment))
      .accountsPartial({
        owner,
        vaultConfig: vaultPda,
        heartbeatRecord: heartbeatPda,
        assetPlan: assetPlanPda,
        systemProgram: SystemProgram.programId,
      })
      .transaction();

    return this.addPriorityFee(tx, [owner, vaultPda, assetPlanPda], 250_000);
  }

  async buildUpdateAssetPlanTx(owner: PublicKey, assignments: AssetAssignment[]): Promise<Transaction> {
    const [vaultPda] = this.getVaultPDA(owner);
    const [heartbeatPda] = this.getHeartbeatPDA(vaultPda);
    const [assetPlanPda] = this.getAssetPlanPDA(vaultPda);
    const program = this.programAs(owner);

    const tx = await program.methods
      .updateAssetPlan(assignments.map(VaultTransactionService.toOnChainAssignment))
      .accountsPartial({
        owner,
        vaultConfig: vaultPda,
        heartbeatRecord: heartbeatPda,
        assetPlan: assetPlanPda,
      })
      .transaction();

    return this.addPriorityFee(tx, [owner, vaultPda, assetPlanPda], 250_000);
  }

  private static toOnChainAssignment(a: AssetAssignment) {
    return {
      mint: a.mint,
      amount: BN.isBN(a.amount) ? (a.amount as BN) : new BN(a.amount as number),
      beneficiaryIndex: a.beneficiaryIndex,
      isNft: a.isNft,
    };
  }

  // ─── Permissionless execution crank (build + send with a payer keypair) ───

  async crankBeginExecution(payer: Keypair, owner: PublicKey, hasAssetPlan: boolean): Promise<string> {
    const [vaultPda] = this.getVaultPDA(owner);
    const [heartbeatPda] = this.getHeartbeatPDA(vaultPda);
    const [executionPda] = this.getExecutionPDA(vaultPda);
    const [assetPlanPda] = this.getAssetPlanPDA(vaultPda);
    const program = this.programAs(payer.publicKey);

    // The optional asset_plan MUST be passed explicitly (the PDA when a plan
    // exists — so begin_execution can carve specific-SOL out of the residual —
    // otherwise null; omitting it makes Anchor auto-derive a non-existent PDA).
    const ix = await program.methods
      .beginExecution()
      .accountsPartial({
        payer: payer.publicKey,
        vaultConfig: vaultPda,
        heartbeatRecord: heartbeatPda,
        executionLog: executionPda,
        assetPlan: hasAssetPlan ? assetPlanPda : null,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    return this.sendWithPayer([ix], payer, [vaultPda, heartbeatPda, executionPda, payer.publicKey], 120_000);
  }

  /** Pay a specific-SOL bequest (assignment whose mint is the zero-pubkey sentinel). */
  async crankExecuteSpecificSol(
    payer: Keypair,
    owner: PublicKey,
    assignmentIndex: number,
    beneficiaryWallet: PublicKey,
  ): Promise<string> {
    const [vaultPda] = this.getVaultPDA(owner);
    const [executionPda] = this.getExecutionPDA(vaultPda);
    const [assetPlanPda] = this.getAssetPlanPDA(vaultPda);
    const program = this.programAs(payer.publicKey);

    const ix = await program.methods
      .executeSpecificSol(assignmentIndex)
      .accountsPartial({
        payer: payer.publicKey,
        vaultConfig: vaultPda,
        executionLog: executionPda,
        assetPlan: assetPlanPda,
        beneficiary: beneficiaryWallet,
      })
      .instruction();

    return this.sendWithPayer([ix], payer, [vaultPda, beneficiaryWallet, payer.publicKey], 120_000);
  }

  async crankBeginTokenDist(
    payer: Keypair,
    owner: PublicKey,
    mint: PublicKey,
    hasAssetPlan: boolean,
  ): Promise<string> {
    const [vaultPda] = this.getVaultPDA(owner);
    const [executionPda] = this.getExecutionPDA(vaultPda);
    const [tokenDistPda] = this.getTokenDistPDA(vaultPda, mint);
    const [assetPlanPda] = this.getAssetPlanPDA(vaultPda);
    const tokenProgram = await this.getTokenProgramForMint(mint);
    const vaultAta = this.ataFor(mint, vaultPda, true, tokenProgram);
    const program = this.programAs(payer.publicKey);

    const ix = await program.methods
      .beginTokenDist()
      .accountsPartial({
        payer: payer.publicKey,
        vaultConfig: vaultPda,
        executionLog: executionPda,
        mint,
        vaultAta,
        assetPlan: hasAssetPlan ? assetPlanPda : null,
        tokenDist: tokenDistPda,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    return this.sendWithPayer([ix], payer, [vaultPda, executionPda, tokenDistPda, mint, payer.publicKey], 120_000);
  }

  async crankExecuteSpecificAsset(
    payer: Keypair,
    owner: PublicKey,
    mint: PublicKey,
    assignmentIndex: number,
    beneficiaryWallet: PublicKey,
  ): Promise<string> {
    const [vaultPda] = this.getVaultPDA(owner);
    const [executionPda] = this.getExecutionPDA(vaultPda);
    const [assetPlanPda] = this.getAssetPlanPDA(vaultPda);
    const [tokenDistPda] = this.getTokenDistPDA(vaultPda, mint);
    const tokenProgram = await this.getTokenProgramForMint(mint);
    const vaultAta = this.ataFor(mint, vaultPda, true, tokenProgram);
    const beneficiaryAta = this.ataFor(mint, beneficiaryWallet, false, tokenProgram);
    const program = this.programAs(payer.publicKey);

    const ixs: TransactionInstruction[] = [];
    if (!(await this.accountExists(beneficiaryAta))) {
      ixs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey, beneficiaryAta, beneficiaryWallet, mint, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
      );
    }

    const ix = await program.methods
      .executeSpecificAsset(assignmentIndex)
      .accountsPartial({
        payer: payer.publicKey,
        vaultConfig: vaultPda,
        executionLog: executionPda,
        assetPlan: assetPlanPda,
        mint,
        tokenDist: tokenDistPda,
        vaultAta,
        beneficiaryAta,
        tokenProgram,
      })
      .instruction();
    ixs.push(ix);

    return this.sendWithPayer(ixs, payer, [vaultPda, tokenDistPda, mint, beneficiaryAta, payer.publicKey], 200_000);
  }

  async crankExecuteSolShares(
    payer: Keypair,
    owner: PublicKey,
    indices: number[],
    beneficiaryWallets: PublicKey[],
  ): Promise<string> {
    const [vaultPda] = this.getVaultPDA(owner);
    const [executionPda] = this.getExecutionPDA(vaultPda);
    const program = this.programAs(payer.publicKey);

    const ix = await program.methods
      .executeSolShares(Buffer.from(indices))
      .accountsPartial({
        payer: payer.publicKey,
        vaultConfig: vaultPda,
        executionLog: executionPda,
      })
      .remainingAccounts(
        beneficiaryWallets.map((w) => ({ pubkey: w, isWritable: true, isSigner: false })),
      )
      .instruction();

    return this.sendWithPayer([ix], payer, [vaultPda, executionPda, payer.publicKey], 200_000);
  }

  async crankExecuteTokenShares(
    payer: Keypair,
    owner: PublicKey,
    mint: PublicKey,
    indices: number[],
    beneficiaryWallets: PublicKey[],
  ): Promise<string> {
    const [vaultPda] = this.getVaultPDA(owner);
    const [tokenDistPda] = this.getTokenDistPDA(vaultPda, mint);
    const tokenProgram = await this.getTokenProgramForMint(mint);
    const vaultAta = this.ataFor(mint, vaultPda, true, tokenProgram);
    const program = this.programAs(payer.publicKey);

    // Create any missing beneficiary ATAs up-front (payer funds the rent).
    const setupIxs: TransactionInstruction[] = [];
    const beneficiaryAtas: PublicKey[] = [];
    for (const w of beneficiaryWallets) {
      const ata = this.ataFor(mint, w, false, tokenProgram);
      beneficiaryAtas.push(ata);
      if (!(await this.accountExists(ata))) {
        setupIxs.push(
          createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, w, mint, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID),
        );
      }
    }

    // ATA creations are independent of mint program state — send them first so
    // the share tx stays within CU/size limits.
    if (setupIxs.length > 0) {
      await this.sendWithPayer(setupIxs, payer, [payer.publicKey, mint], 50_000 + setupIxs.length * 30_000);
    }

    const ix = await program.methods
      .executeTokenShares(Buffer.from(indices))
      .accountsPartial({
        payer: payer.publicKey,
        vaultConfig: vaultPda,
        tokenDist: tokenDistPda,
        mint,
        vaultAta,
        tokenProgram,
      })
      .remainingAccounts(
        beneficiaryAtas.map((a) => ({ pubkey: a, isWritable: true, isSigner: false })),
      )
      .instruction();

    return this.sendWithPayer([ix], payer, [vaultPda, tokenDistPda, mint, payer.publicKey], 200_000);
  }

  async crankFinalize(payer: Keypair, owner: PublicKey, hasAssetPlan: boolean): Promise<string> {
    const [vaultPda] = this.getVaultPDA(owner);
    const [executionPda] = this.getExecutionPDA(vaultPda);
    const [assetPlanPda] = this.getAssetPlanPDA(vaultPda);
    const program = this.programAs(payer.publicKey);

    const ix = await program.methods
      .finalizeExecution()
      .accountsPartial({
        payer: payer.publicKey,
        vaultConfig: vaultPda,
        executionLog: executionPda,
        assetPlan: hasAssetPlan ? assetPlanPda : null,
      })
      .instruction();

    return this.sendWithPayer([ix], payer, [vaultPda, executionPda, payer.publicKey], 100_000);
  }

  async crankCloseTokenDist(
    payer: Keypair,
    owner: PublicKey,
    mint: PublicKey,
    largestBenefWallet: PublicKey,
  ): Promise<string> {
    const [vaultPda] = this.getVaultPDA(owner);
    const [tokenDistPda] = this.getTokenDistPDA(vaultPda, mint);
    const tokenProgram = await this.getTokenProgramForMint(mint);
    const vaultAta = this.ataFor(mint, vaultPda, true, tokenProgram);
    const program = this.programAs(payer.publicKey);

    // The on-chain close only sweeps dust → largest beneficiary when the vault
    // ATA still holds a balance; pass that account only when there is dust
    // (matches the keeper executor), otherwise omit it.
    let dust = 0n;
    try {
      const bal = await this.connection.getTokenAccountBalance(vaultAta);
      dust = BigInt(bal.value.amount);
    } catch {
      dust = 0n;
    }

    let largestBenefAta: PublicKey | null = null;
    if (dust > 0n) {
      largestBenefAta = this.ataFor(mint, largestBenefWallet, false, tokenProgram);
      if (!(await this.accountExists(largestBenefAta))) {
        await this.sendWithPayer(
          [
            createAssociatedTokenAccountIdempotentInstruction(
              payer.publicKey, largestBenefAta, largestBenefWallet, mint, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID,
            ),
          ],
          payer,
          [payer.publicKey, mint],
          80_000,
        );
      }
    }

    const ix = await program.methods
      .closeTokenDist()
      .accountsPartial({
        payer: payer.publicKey,
        owner,
        vaultConfig: vaultPda,
        mint,
        vaultAta,
        tokenDist: tokenDistPda,
        largestBenefAta,
        tokenProgram,
      })
      .instruction();

    return this.sendWithPayer([ix], payer, [vaultPda, tokenDistPda, mint, payer.publicKey], 150_000);
  }

  // ─── Beneficiary claim (MWA — heir is the fee payer, not a local Keypair) ───

  /**
   * Build the unsigned distribution transactions for a beneficiary "claim". Same
   * permissionless crank the owner app / server run, but with `heir` as the fee
   * payer so it can be MWA-signed. Returns ordered `{label, tx}` groups (each tx
   * carries its compute-budget + priority-fee ixs; the caller sets feePayer +
   * blockhash and signs). Idempotent: skips steps already recorded in the on-chain
   * masks. Token-dist CLOSE is handled separately (see buildCloseTokenDistTransactions)
   * because dust is only known after the residual shares land.
   */
  async buildClaimTransactions(
    heir: PublicKey,
    owner: PublicKey,
  ): Promise<{ label: string; tx: Transaction }[]> {
    const config = await this.fetchVaultConfig(owner);
    if (!config) throw new Error('No vault found for this owner.');
    // NOTE: do NOT bail on config.executed — token residual shares
    // (execute_token_shares) legitimately run AFTER finalize sets executed=true.
    // This builder is idempotent (skips work already recorded on-chain) and is
    // called in a loop by ClaimService until it returns no further steps, so a
    // fresh token vault completes across passes (begin_token_dist must land before
    // its residual shares/TokenDist are visible). Returns [] when nothing remains.

    const shareInfos = config.beneficiaries.map((b: any) => ({
      wallet: new PublicKey(b.wallet),
      shareBps: b.shareBps as number,
    }));
    const benefWallets: PublicKey[] = shareInfos.map((b: { wallet: PublicKey }) => b.wallet);
    const n = benefWallets.length;
    const hasAssetPlan = !!config.hasAssetPlan;

    const [vaultPda] = this.getVaultPDA(owner);
    const [heartbeatPda] = this.getHeartbeatPDA(vaultPda);
    const [executionPda] = this.getExecutionPDA(vaultPda);
    const [assetPlanPda] = this.getAssetPlanPDA(vaultPda);
    const program = this.programAs(heir);

    const execLog = await this.fetchExecutionLog(owner);
    const tokenBalances = await this.getVaultTokenBalances(vaultPda);
    const mintMap = new Map<string, PublicKey>();
    for (const t of tokenBalances) mintMap.set(t.mint.toString(), t.mint);
    const assetPlan = hasAssetPlan ? await this.fetchAssetPlan(owner) : null;
    if (assetPlan) {
      for (const a of assetPlan.assignments) {
        if (!a.mint.equals(PublicKey.default)) mintMap.set(a.mint.toString(), a.mint);
      }
    }
    const mints = [...mintMap.values()];

    const range = (k: number) => Array.from({ length: k }, (_, i) => i);
    const unpaid = (mask: number) => range(n).filter((i) => ((mask >>> i) & 1) === 0);
    const chunk8 = (a: number[]) => {
      const o: number[][] = [];
      for (let i = 0; i < a.length; i += 8) o.push(a.slice(i, i + 8));
      return o;
    };
    const wrap = async (ixs: TransactionInstruction[], keys: PublicKey[], cu: number) => {
      const raw = new Transaction();
      for (const ix of ixs) raw.add(ix);
      return this.addPriorityFee(raw, keys, cu);
    };
    const walletMetas = (idxs: number[]) =>
      idxs.map((i) => ({ pubkey: benefWallets[i], isWritable: true, isSigner: false }));

    const out: { label: string; tx: Transaction }[] = [];

    // FAST PATH: fresh + pure SOL + ≤8 beneficiaries → one transaction.
    if (!execLog && mints.length === 0 && !hasAssetPlan && n <= 8) {
      const ixs: TransactionInstruction[] = [
        await program.methods
          .beginExecution()
          .accountsPartial({ payer: heir, vaultConfig: vaultPda, heartbeatRecord: heartbeatPda, executionLog: executionPda, assetPlan: null, systemProgram: SystemProgram.programId })
          .instruction(),
        await program.methods
          .executeSolShares(Buffer.from(range(n)))
          .accountsPartial({ payer: heir, vaultConfig: vaultPda, executionLog: executionPda })
          .remainingAccounts(walletMetas(range(n)))
          .instruction(),
        await program.methods
          .finalizeExecution()
          .accountsPartial({ payer: heir, vaultConfig: vaultPda, executionLog: executionPda, assetPlan: null })
          .instruction(),
      ];
      out.push({ label: 'Distribute estate', tx: await wrap(ixs, [vaultPda, executionPda, heir], 400_000) });
      return out;
    }

    // GENERAL PATH — mirrors ExecutionService step order.
    if (!execLog) {
      const ix = await program.methods
        .beginExecution()
        .accountsPartial({ payer: heir, vaultConfig: vaultPda, heartbeatRecord: heartbeatPda, executionLog: executionPda, assetPlan: hasAssetPlan ? assetPlanPda : null, systemProgram: SystemProgram.programId })
        .instruction();
      out.push({ label: 'Begin distribution', tx: await wrap([ix], [vaultPda, heartbeatPda, executionPda, heir], 120_000) });
    }

    for (const mint of mints) {
      if (await this.fetchTokenDist(owner, mint)) continue;
      const tokenProgram = await this.getTokenProgramForMint(mint);
      const vaultAta = this.ataFor(mint, vaultPda, true, tokenProgram);
      const [tokenDistPda] = this.getTokenDistPDA(vaultPda, mint);
      const ix = await program.methods
        .beginTokenDist()
        .accountsPartial({ payer: heir, vaultConfig: vaultPda, executionLog: executionPda, mint, vaultAta, assetPlan: hasAssetPlan ? assetPlanPda : null, tokenDist: tokenDistPda, systemProgram: SystemProgram.programId })
        .instruction();
      out.push({ label: `Snapshot ${mint.toString().slice(0, 4)}… balance`, tx: await wrap([ix], [vaultPda, executionPda, tokenDistPda, mint, heir], 120_000) });
    }

    if (assetPlan) {
      for (let j = 0; j < assetPlan.assignments.length; j++) {
        if ((assetPlan.paidMask & (1n << BigInt(j))) !== 0n) continue;
        const a = assetPlan.assignments[j];
        const benef = benefWallets[a.beneficiaryIndex];
        if (a.mint.equals(PublicKey.default)) {
          const ix = await program.methods
            .executeSpecificSol(j)
            .accountsPartial({ payer: heir, vaultConfig: vaultPda, executionLog: executionPda, assetPlan: assetPlanPda, beneficiary: benef })
            .instruction();
          out.push({ label: `Pay bequest #${j + 1} (SOL)`, tx: await wrap([ix], [vaultPda, benef, heir], 120_000) });
        } else {
          const tokenProgram = await this.getTokenProgramForMint(a.mint);
          const vaultAta = this.ataFor(a.mint, vaultPda, true, tokenProgram);
          const benefAta = this.ataFor(a.mint, benef, false, tokenProgram);
          const [tokenDistPda] = this.getTokenDistPDA(vaultPda, a.mint);
          const ixs: TransactionInstruction[] = [];
          if (!(await this.accountExists(benefAta))) {
            ixs.push(createAssociatedTokenAccountIdempotentInstruction(heir, benefAta, benef, a.mint, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID));
          }
          ixs.push(
            await program.methods
              .executeSpecificAsset(j)
              .accountsPartial({ payer: heir, vaultConfig: vaultPda, executionLog: executionPda, assetPlan: assetPlanPda, mint: a.mint, tokenDist: tokenDistPda, vaultAta, beneficiaryAta: benefAta, tokenProgram })
              .instruction(),
          );
          out.push({ label: `Pay bequest #${j + 1}`, tx: await wrap(ixs, [vaultPda, tokenDistPda, a.mint, benefAta, heir], 200_000) });
        }
      }
    }

    for (const batch of chunk8(unpaid(execLog ? execLog.solPaidMask : 0))) {
      const ix = await program.methods
        .executeSolShares(Buffer.from(batch))
        .accountsPartial({ payer: heir, vaultConfig: vaultPda, executionLog: executionPda })
        .remainingAccounts(walletMetas(batch))
        .instruction();
      out.push({ label: 'Distribute SOL shares', tx: await wrap([ix], [vaultPda, executionPda, heir], 250_000) });
    }

    if (!execLog?.completed) {
      const ix = await program.methods
        .finalizeExecution()
        .accountsPartial({ payer: heir, vaultConfig: vaultPda, executionLog: executionPda, assetPlan: hasAssetPlan ? assetPlanPda : null })
        .instruction();
      out.push({ label: 'Finalize distribution', tx: await wrap([ix], [vaultPda, executionPda, heir], 100_000) });
    }

    for (const mint of mints) {
      const td = await this.fetchTokenDist(owner, mint);
      if (!td) continue;
      const tokenProgram = await this.getTokenProgramForMint(mint);
      const vaultAta = this.ataFor(mint, vaultPda, true, tokenProgram);
      const [tokenDistPda] = this.getTokenDistPDA(vaultPda, mint);
      for (const batch of chunk8(unpaid(td.paidMask))) {
        const ixs: TransactionInstruction[] = [];
        const atas: PublicKey[] = [];
        for (const i of batch) {
          const ata = this.ataFor(mint, benefWallets[i], false, tokenProgram);
          atas.push(ata);
          if (!(await this.accountExists(ata))) {
            ixs.push(createAssociatedTokenAccountIdempotentInstruction(heir, ata, benefWallets[i], mint, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID));
          }
        }
        ixs.push(
          await program.methods
            .executeTokenShares(Buffer.from(batch))
            .accountsPartial({ payer: heir, vaultConfig: vaultPda, tokenDist: tokenDistPda, mint, vaultAta, tokenProgram })
            .remainingAccounts(atas.map((a) => ({ pubkey: a, isWritable: true, isSigner: false })))
            .instruction(),
        );
        out.push({ label: `Distribute ${mint.toString().slice(0, 4)}…`, tx: await wrap(ixs, [vaultPda, tokenDistPda, mint, heir], 250_000) });
      }
    }

    return out;
  }

  /**
   * Close any fully-paid TokenDists after a claim's residual shares have landed
   * (built here, not in buildClaimTransactions, because the dust sweep depends on
   * the post-distribution ATA balance). Sweeps dust → largest-share beneficiary,
   * closes the vault ATA + TokenDist. Best-effort cleanup — the distribution is
   * already complete without it.
   */
  async buildCloseTokenDistTransactions(
    heir: PublicKey,
    owner: PublicKey,
  ): Promise<{ label: string; tx: Transaction }[]> {
    const config = await this.fetchVaultConfig(owner);
    if (!config) return [];
    const shareInfos = config.beneficiaries.map((b: any) => ({ wallet: new PublicKey(b.wallet), shareBps: b.shareBps as number }));
    const n = shareInfos.length;
    const largestBenef = VaultTransactionService.largestShareWallet(shareInfos);
    const fullMask = n >= 32 ? 0xffffffff : (((1 << n) - 1) >>> 0);

    const [vaultPda] = this.getVaultPDA(owner);
    const program = this.programAs(heir);

    const tokenBalances = await this.getVaultTokenBalances(vaultPda);
    const mintMap = new Map<string, PublicKey>();
    for (const t of tokenBalances) mintMap.set(t.mint.toString(), t.mint);
    const assetPlan = config.hasAssetPlan ? await this.fetchAssetPlan(owner) : null;
    if (assetPlan) {
      for (const a of assetPlan.assignments) {
        if (!a.mint.equals(PublicKey.default)) mintMap.set(a.mint.toString(), a.mint);
      }
    }

    const out: { label: string; tx: Transaction }[] = [];
    for (const mint of [...mintMap.values()]) {
      const td = await this.fetchTokenDist(owner, mint);
      if (!td || (td.paidMask >>> 0) !== fullMask) continue;
      const tokenProgram = await this.getTokenProgramForMint(mint);
      const vaultAta = this.ataFor(mint, vaultPda, true, tokenProgram);
      const [tokenDistPda] = this.getTokenDistPDA(vaultPda, mint);

      let dust = 0n;
      try {
        const bal = await this.connection.getTokenAccountBalance(vaultAta);
        dust = BigInt(bal.value.amount);
      } catch { dust = 0n; }

      const ixs: TransactionInstruction[] = [];
      let largestBenefAta: PublicKey | null = null;
      if (dust > 0n) {
        largestBenefAta = this.ataFor(mint, largestBenef, false, tokenProgram);
        if (!(await this.accountExists(largestBenefAta))) {
          ixs.push(createAssociatedTokenAccountIdempotentInstruction(heir, largestBenefAta, largestBenef, mint, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID));
        }
      }
      ixs.push(
        await program.methods
          .closeTokenDist()
          .accountsPartial({ payer: heir, owner, vaultConfig: vaultPda, mint, vaultAta, tokenDist: tokenDistPda, largestBenefAta, tokenProgram })
          .instruction(),
      );
      const raw = new Transaction();
      for (const ix of ixs) raw.add(ix);
      out.push({ label: `Close ${mint.toString().slice(0, 4)}… account`, tx: await this.addPriorityFee(raw, [vaultPda, tokenDistPda, mint, heir], 150_000) });
    }
    return out;
  }

  // ─── Account reads ───

  private async accountExists(pubkey: PublicKey): Promise<boolean> {
    const info = await this.connection.getAccountInfo(pubkey);
    return info !== null;
  }

  private async assetPlanIfPresent(owner: PublicKey): Promise<PublicKey | null> {
    const config = await this.fetchVaultConfig(owner);
    if (!config?.hasAssetPlan) return null;
    const [vaultPda] = this.getVaultPDA(owner);
    return this.getAssetPlanPDA(vaultPda)[0];
  }

  static largestShareWallet(beneficiaries: { wallet: PublicKey; shareBps: number }[]): PublicKey {
    let best = beneficiaries[0];
    for (const b of beneficiaries) {
      if (b.shareBps > best.shareBps) best = b;
    }
    return best.wallet;
  }

  async fetchVaultConfig(owner: PublicKey): Promise<any | null> {
    const [pda] = this.getVaultPDA(owner);
    try {
      const program = this.programAs(owner);
      return await program.account.vaultConfig.fetch(pda);
    } catch {
      // fall through to raw parse
    }
    try {
      const rawAccount = await this.connection.getAccountInfo(pda);
      if (!rawAccount || rawAccount.data.length < 92) return null;
      return VaultTransactionService.parseVaultConfigRaw(rawAccount.data);
    } catch {
      return null;
    }
  }

  /**
   * VaultConfig raw layout:
   * 8 disc | 32 owner | 32 agent | 8 interval | 8 grace | 4 vec_len |
   * N*(32 wallet + 2 shareBps) | 1 executed | 1 active | 8 created | 8 updated |
   * 1 bump | 1 is_mutable | 1 has_asset_plan | 2 open_token_dists
   */
  static parseVaultConfigRaw(data: Buffer): any {
    let offset = 8;
    const owner = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
    const agentPubkey = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
    const heartbeatInterval = new BN(data.subarray(offset, offset + 8), 'le'); offset += 8;
    const gracePeriod = new BN(data.subarray(offset, offset + 8), 'le'); offset += 8;

    const beneficiaryCount = data.readUInt32LE(offset); offset += 4;
    const beneficiaries: { wallet: PublicKey; shareBps: number; hasSpecificAssets: boolean }[] = [];
    for (let i = 0; i < beneficiaryCount && i < 20; i++) {
      const wallet = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
      const shareBps = data.readUInt16LE(offset); offset += 2;
      beneficiaries.push({ wallet, shareBps, hasSpecificAssets: false });
    }

    const executed = data[offset] !== 0; offset += 1;
    const active = data[offset] !== 0; offset += 1;
    const createdAt = new BN(data.subarray(offset, offset + 8), 'le'); offset += 8;
    const updatedAt = new BN(data.subarray(offset, offset + 8), 'le'); offset += 8;
    const bump = data[offset]; offset += 1;
    const isMutable = data[offset] !== 0; offset += 1;
    const hasAssetPlan = data[offset] !== 0; offset += 1;
    const openTokenDists = data.readUInt16LE(offset); offset += 2;

    return {
      owner, agentPubkey, heartbeatInterval, gracePeriod,
      beneficiaries, executed, active, createdAt, updatedAt,
      bump, isMutable, hasAssetPlan, openTokenDists,
    };
  }

  /**
   * ExecutionLog raw layout:
   * 8 disc | 32 vault | 8 sol_snapshot | 4 sol_paid_mask | 8 started_at |
   * 1 completed | 4 transfer_count | 8 total_sol | 1 bump
   */
  async fetchExecutionLog(owner: PublicKey): Promise<{ solSnapshot: BN; solPaidMask: number; completed: boolean } | null> {
    const [vaultPda] = this.getVaultPDA(owner);
    const [executionPda] = this.getExecutionPDA(vaultPda);
    const info = await this.connection.getAccountInfo(executionPda);
    if (!info || info.data.length < 66) return null;
    const data = info.data;
    let offset = 8 + 32;
    const solSnapshot = new BN(data.subarray(offset, offset + 8), 'le'); offset += 8;
    const solPaidMask = data.readUInt32LE(offset); offset += 4;
    offset += 8; // started_at
    const completed = data[offset] !== 0;
    return { solSnapshot, solPaidMask, completed };
  }

  /**
   * AssetPlan raw layout:
   * 8 disc | 32 vault | 4 vec_len | N*(32 mint + 8 amount + 1 benefIdx + 1 isNft) |
   * 8 paid_mask | 1 bump
   */
  async fetchAssetPlan(owner: PublicKey): Promise<{
    assignments: { mint: PublicKey; amount: BN; beneficiaryIndex: number; isNft: boolean }[];
    paidMask: bigint;
  } | null> {
    const [vaultPda] = this.getVaultPDA(owner);
    const [assetPlanPda] = this.getAssetPlanPDA(vaultPda);
    const info = await this.connection.getAccountInfo(assetPlanPda);
    if (!info || info.data.length < 44) return null;
    const data = info.data;
    let offset = 8 + 32;
    const len = data.readUInt32LE(offset); offset += 4;
    const assignments: { mint: PublicKey; amount: BN; beneficiaryIndex: number; isNft: boolean }[] = [];
    for (let i = 0; i < len && i < 64; i++) {
      const mint = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
      const amount = new BN(data.subarray(offset, offset + 8), 'le'); offset += 8;
      const beneficiaryIndex = data[offset]; offset += 1;
      const isNft = data[offset] !== 0; offset += 1;
      assignments.push({ mint, amount, beneficiaryIndex, isNft });
    }
    const paidMask = data.readBigUInt64LE(offset);
    return { assignments, paidMask };
  }

  /**
   * TokenDist raw layout:
   * 8 disc | 32 vault | 32 mint | 8 snapshot | 4 paid_mask | 1 bump
   */
  async fetchTokenDist(owner: PublicKey, mint: PublicKey): Promise<{ snapshot: BN; paidMask: number } | null> {
    const [vaultPda] = this.getVaultPDA(owner);
    const [tokenDistPda] = this.getTokenDistPDA(vaultPda, mint);
    const info = await this.connection.getAccountInfo(tokenDistPda);
    if (!info || info.data.length < 85) return null;
    const data = info.data;
    let offset = 8 + 32 + 32;
    const snapshot = new BN(data.subarray(offset, offset + 8), 'le'); offset += 8;
    const paidMask = data.readUInt32LE(offset);
    return { snapshot, paidMask };
  }

  async getOnChainDeadline(owner: PublicKey): Promise<number | null> {
    const [vaultPda] = this.getVaultPDA(owner);
    const [heartbeatPda] = this.getHeartbeatPDA(vaultPda);
    try {
      const [vaultInfo, hbInfo] = await Promise.all([
        this.connection.getAccountInfo(vaultPda),
        this.connection.getAccountInfo(heartbeatPda),
      ]);
      if (!vaultInfo || !hbInfo) return null;
      const interval = Number(new BN(vaultInfo.data.subarray(72, 80), 'le'));
      const grace = Number(new BN(vaultInfo.data.subarray(80, 88), 'le'));
      const lastHeartbeat = Number(new BN(hbInfo.data.subarray(40, 48), 'le'));
      return lastHeartbeat + interval + grace;
    } catch {
      return null;
    }
  }

  /** All token balances held by the vault PDA (across Token + Token-2022). */
  async getVaultTokenBalances(vaultPda: PublicKey): Promise<{
    mint: PublicKey;
    amount: number;
    decimals: number;
    uiAmount: number;
  }[]> {
    const programs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
    const results: { mint: PublicKey; amount: number; decimals: number; uiAmount: number }[] = [];
    for (const programIdToken of programs) {
      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(vaultPda, { programId: programIdToken });
      for (const { account } of tokenAccounts.value) {
        const parsed = account.data.parsed?.info;
        if (!parsed) continue;
        const tokenAmount = parsed.tokenAmount;
        if (Number(tokenAmount.amount) <= 0) continue;
        results.push({
          mint: new PublicKey(parsed.mint),
          amount: Number(tokenAmount.amount),
          decimals: tokenAmount.decimals,
          uiAmount: Number(tokenAmount.uiAmountString),
        });
      }
    }
    return results;
  }

  /**
   * Build instructions to withdraw ALL assets from the vault PDA back to the
   * owner (used by revoke). NOTE: emptied vault ATAs are left open in v1 — the
   * close_vault_ata instruction was folded into the post-execution
   * close_token_dist path, so pre-execution withdrawal no longer closes ATAs
   * (a small ~0.002 SOL/ATA rent stays in the vault until execution).
   */
  async buildWithdrawAllInstructions(
    owner: PublicKey,
  ): Promise<{ instructions: TransactionInstruction[]; assetCount: number }> {
    const [vaultPda] = this.getVaultPDA(owner);
    const [heartbeatPda] = this.getHeartbeatPDA(vaultPda);
    const program = this.programAs(owner);

    const instructions: TransactionInstruction[] = [];
    let assetCount = 0;

    const vaultTokens = await this.getVaultTokenBalances(vaultPda);
    for (const token of vaultTokens) {
      const ownerAta = await getAssociatedTokenAddress(token.mint, owner);
      const vaultAta = await getAssociatedTokenAddress(token.mint, vaultPda, true);

      try {
        await getAccount(this.connection, ownerAta);
      } catch {
        instructions.push(
          createAssociatedTokenAccountIdempotentInstruction(owner, ownerAta, owner, token.mint),
        );
      }

      const ix = await program.methods
        .withdrawFromVault(new BN(token.amount))
        .accountsPartial({
          owner,
          vaultConfig: vaultPda,
          heartbeatRecord: heartbeatPda,
          sourceTokenAccount: vaultAta,
          destinationTokenAccount: ownerAta,
          vaultAuthority: vaultPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();
      instructions.push(ix);
      assetCount++;
    }

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
            heartbeatRecord: heartbeatPda,
          })
          .instruction();
        instructions.push(ix);
        assetCount++;
      }
    }

    return { instructions, assetCount };
  }

  /**
   * Pack withdrawal instructions (and optionally revoke) into minimal txs.
   * 8 instructions fit per TX within the 1232-byte limit.
   */
  async buildBatchedTxs(
    owner: PublicKey,
    withdrawIxs: TransactionInstruction[],
    options?: { includeRevoke?: boolean },
  ): Promise<Transaction[]> {
    const MAX_IXS_PER_TX = 8;
    const [vaultPda] = this.getVaultPDA(owner);

    const chunks: TransactionInstruction[][] = [];
    for (let i = 0; i < withdrawIxs.length; i += MAX_IXS_PER_TX) {
      chunks.push(withdrawIxs.slice(i, i + MAX_IXS_PER_TX));
    }
    if (chunks.length === 0 && options?.includeRevoke) {
      chunks.push([]);
    }

    if (options?.includeRevoke && chunks.length > 0) {
      const [heartbeatPda] = this.getHeartbeatPDA(vaultPda);
      const assetPlan = await this.assetPlanIfPresent(owner);
      const program = this.programAs(owner);
      const revokeIx = await program.methods
        .revokeVault()
        .accountsPartial({
          owner,
          vaultConfig: vaultPda,
          heartbeatRecord: heartbeatPda,
          assetPlan,
        })
        .instruction();
      chunks[chunks.length - 1].push(revokeIx);
    }

    const txs: Transaction[] = [];
    for (const chunk of chunks) {
      const tx = new Transaction();
      for (const ix of chunk) {
        tx.add(ix);
      }
      const cuLimit = 50_000 + chunk.length * 30_000;
      const priorityTx = await this.addPriorityFee(tx, [owner, vaultPda], cuLimit);
      txs.push(priorityTx);
    }

    return txs;
  }
}
