import { PublicKey } from '@solana/web3.js';
import { HELIUS_ENHANCED_API, HELIUS_API_KEY, PROGRAM_ID } from '../utils/constants';
import { fetchWithRetry } from '../utils/fetchWithRetry';

export interface ExecutionSummary {
  executedAt: number;
  recordTxSignature: string;
  steps: HistoryStep[];
  totalSolDistributed: number;
  tokenTransferCount: number;
}

export interface HistoryStep {
  type: string;
  txSignature: string;
  timestamp: number;
  description: string;
  solAmount?: number;
  tokenMint?: string;
  tokenAmount?: number;
}

interface HeliusTx {
  signature: string;
  timestamp: number;
  type: string;
  source: string;
  fee: number;
  feePayer: string;
  description: string;
  nativeTransfers?: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    amount: number;
  }>;
  tokenTransfers?: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    mint: string;
    tokenAmount: number;
    tokenStandard: string;
  }>;
  accountData?: Array<{
    account: string;
    nativeBalanceChange: number;
    tokenBalanceChanges: any[];
  }>;
  instructions?: Array<{
    programId: string;
    accounts: string[];
    data: string;
    innerInstructions?: any[];
  }>;
  events?: Record<string, any>;
}

/**
 * Fetches historical vault execution data from Helius Enhanced TX History.
 * Groups transactions by execution session (each RecordExecution marks end of session).
 */
export async function getExecutionHistory(wallet: PublicKey): Promise<ExecutionSummary[]> {
  if (!HELIUS_API_KEY) return [];

  // Query the vault PDA — it's an account in ALL vault transactions
  // (init, heartbeat, distributions, record, close)
  const programId = new PublicKey(PROGRAM_ID);
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), wallet.toBuffer()],
    programId,
  );
  const walletStr = vaultPda.toString();
  const allTxs: HeliusTx[] = [];
  let beforeSig: string | undefined;
  const MAX_PAGES = 5;

  for (let page = 0; page < MAX_PAGES; page++) {
    let url = `${HELIUS_ENHANCED_API}/addresses/${walletStr}/transactions/?api-key=${HELIUS_API_KEY}&limit=50&commitment=confirmed`;
    if (beforeSig) {
      url += `&before=${beforeSig}`;
    }

    try {
      const response = await fetchWithRetry(url);
      if (!response.ok) break;

      const transactions: HeliusTx[] = await response.json();
      if (transactions.length === 0) break;

      // Filter for transactions involving our program
      for (const tx of transactions) {
        const involvesProgram = (tx.instructions?.some(
          (ix) => ix.programId === PROGRAM_ID,
        ) || tx.accountData?.some(
          (a) => a.account === PROGRAM_ID,
        )) ?? false;

        if (involvesProgram) {
          allTxs.push(tx);
        }
      }

      const lastTx = transactions[transactions.length - 1];
      beforeSig = lastTx?.signature;
      if (!beforeSig || transactions.length < 50) break;
    } catch {
      break;
    }
  }

  if (allTxs.length === 0) return [];

  // Parse instruction type from Helius description or instruction data
  const parsedTxs = allTxs.map((tx) => ({
    ...tx,
    instructionType: parseInstructionType(tx),
  }));

  // Group into execution sessions: RecordExecution marks the end of each session
  return groupIntoSessions(parsedTxs);
}

function parseInstructionType(tx: HeliusTx): string {
  // Helius often puts the instruction name in the description
  const desc = (tx.description || '').toLowerCase();

  if (desc.includes('record') && desc.includes('execution')) return 'RecordExecution';
  if (desc.includes('execute') && desc.includes('sol')) return 'ExecuteSolDistribution';
  if (desc.includes('execute') && desc.includes('distribution')) return 'ExecuteDistribution';
  if (desc.includes('close') && desc.includes('executed')) return 'CloseExecutedVault';
  if (desc.includes('initialize') && desc.includes('vault')) return 'InitializeVault';
  if (desc.includes('heartbeat')) return 'RecordHeartbeat';
  if (desc.includes('revoke')) return 'RevokeVault';
  if (desc.includes('rotate')) return 'RotateAgent';

  // Fallback: check native/token transfers from a vault PDA pattern
  if (tx.nativeTransfers && tx.nativeTransfers.length > 0) {
    const hasOutgoing = tx.nativeTransfers.some(
      (t) => t.fromUserAccount !== tx.feePayer && t.amount > 0,
    );
    if (hasOutgoing) return 'ExecuteSolDistribution';
  }

  if (tx.tokenTransfers && tx.tokenTransfers.length > 0) {
    return 'ExecuteDistribution';
  }

  return 'Unknown';
}

interface ParsedTx extends HeliusTx {
  instructionType: string;
}

function groupIntoSessions(txs: ParsedTx[]): ExecutionSummary[] {
  // Sort by timestamp ascending (oldest first)
  const sorted = [...txs].sort((a, b) => a.timestamp - b.timestamp);

  const executions: ExecutionSummary[] = [];
  let currentSteps: HistoryStep[] = [];

  for (const tx of sorted) {
    const step = buildStep(tx);

    if (tx.instructionType === 'CloseExecutedVault') {
      // Append to the most recent session if one exists
      if (executions.length > 0) {
        executions[executions.length - 1].steps.push(step);
      }
      continue;
    }

    currentSteps.push(step);

    if (tx.instructionType === 'RecordExecution') {
      // Sum SOL distributed from distribution steps
      let totalSol = 0;
      let tokenCount = 0;
      for (const s of currentSteps) {
        if (s.type === 'ExecuteSolDistribution' && s.solAmount) {
          totalSol += s.solAmount;
        }
        if (s.type === 'ExecuteDistribution') {
          tokenCount++;
        }
      }

      executions.push({
        executedAt: tx.timestamp,
        recordTxSignature: tx.signature,
        steps: [...currentSteps],
        totalSolDistributed: totalSol,
        tokenTransferCount: tokenCount,
      });
      currentSteps = [];
    }
  }

  // Return newest first
  return executions.reverse();
}

function buildStep(tx: ParsedTx): HistoryStep {
  let solAmount: number | undefined;
  let tokenMint: string | undefined;
  let tokenAmount: number | undefined;
  let description = tx.instructionType.replace(/([A-Z])/g, ' $1').trim();

  if (tx.instructionType === 'ExecuteSolDistribution' && tx.nativeTransfers) {
    const transfer = tx.nativeTransfers.find(
      (t) => t.fromUserAccount !== tx.feePayer && t.amount > 0,
    );
    if (transfer) {
      solAmount = transfer.amount / 1e9;
      const dest = transfer.toUserAccount;
      description = `${solAmount.toFixed(4)} SOL to ${dest.slice(0, 4)}...${dest.slice(-4)}`;
    }
  }

  if (tx.instructionType === 'ExecuteDistribution' && tx.tokenTransfers) {
    const transfer = tx.tokenTransfers[0];
    if (transfer) {
      tokenMint = transfer.mint;
      tokenAmount = transfer.tokenAmount;
      const dest = transfer.toUserAccount;
      description = `${tokenAmount} tokens to ${dest.slice(0, 4)}...${dest.slice(-4)}`;
    }
  }

  if (tx.instructionType === 'RecordExecution') {
    description = 'Execution recorded on-chain';
  }

  if (tx.instructionType === 'CloseExecutedVault') {
    description = 'Vault PDAs closed, rent returned';
  }

  return {
    type: tx.instructionType,
    txSignature: tx.signature,
    timestamp: tx.timestamp,
    description,
    solAmount,
    tokenMint,
    tokenAmount,
  };
}
