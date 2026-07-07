import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { PROGRAM_ID } from '../utils/constants';
import { heliusEnhancedApi, getHeliusApiKey } from '../utils/rpcConfig';
import { fetchWithRetry } from '../utils/fetchWithRetry';

// Anchor instruction discriminators (first 8 bytes of sha256("global:<name>"), hex)
// → instruction name. Used to identify DMV instructions from on-chain tx data,
// which is far more robust than keyword-matching Helius descriptions.
const DISCRIMINATOR: Record<string, string> = {
  '94f612bcfc5dbb0e': 'begin_execution',
  a734d833266dd66f: 'begin_token_dist',
  e942d5d7f55724ec: 'execute_specific_asset',
  '8dc18312f4da8c19': 'execute_specific_sol',
  '1486822e0c12faef': 'execute_sol_shares',
  '6a869113f0fd79eb': 'execute_token_shares',
  cc927e08c0bd7fa6: 'finalize_execution',
  c34e51efc1260d8b: 'close_token_dist',
  '9657651141c45199': 'close_executed_vault_by_owner',
  '6d2b7edf20464e52': 'record_heartbeat',
  '30bfa32c47813fa4': 'initialize_vault',
  c7ace2acc4f4b367: 'revoke_vault',
  b65b936b9b2f96b0: 'rotate_agent',
  '43e5b9bce20bd23c': 'update_vault',
  '7d2f61393df53c9e': 'withdraw_sol_from_vault',
  b422252e9c00d3ee: 'withdraw_from_vault',
  '9aaeaacb1112478a': 'set_asset_plan',
  db840f16e667d9de: 'update_asset_plan',
  '386b3a1592bd0ad8': 'clear_asset_plan',
};

// Instructions that belong to a distribution session.
const EXECUTION_INSTRUCTIONS = new Set([
  'begin_execution',
  'begin_token_dist',
  'execute_specific_asset',
  'execute_specific_sol',
  'execute_sol_shares',
  'execute_token_shares',
  'finalize_execution',
  'close_token_dist',
  'close_executed_vault_by_owner',
]);

// Human labels per instruction (base description; enriched with transfer amounts).
const LABEL: Record<string, string> = {
  begin_execution: 'Began distribution',
  begin_token_dist: 'Snapshotted token balance',
  execute_specific_asset: 'Paid specific bequest',
  execute_specific_sol: 'Paid SOL bequest',
  execute_sol_shares: 'Distributed SOL shares',
  execute_token_shares: 'Distributed token shares',
  finalize_execution: 'Finalized distribution',
  close_token_dist: 'Closed token distribution',
  close_executed_vault_by_owner: 'Closed vault (rent returned)',
};

// Display priority when a single tx bundles several instructions (e.g. the
// fast-path claim = begin + sol_shares + finalize in one tx).
const PRIORITY = [
  'execute_specific_sol',
  'execute_specific_asset',
  'execute_sol_shares',
  'execute_token_shares',
  'finalize_execution',
  'begin_token_dist',
  'close_token_dist',
  'close_executed_vault_by_owner',
  'begin_execution',
];

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
  if (!getHeliusApiKey()) return [];

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
    let url = `${heliusEnhancedApi()}/addresses/${walletStr}/transactions/?api-key=${getHeliusApiKey()}&limit=50&commitment=confirmed`;
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

  // Identify the DMV instructions in each tx by Anchor discriminator, then group
  // into distribution sessions (one per begin_execution).
  const parsedTxs = allTxs.map((tx) => ({
    ...tx,
    dmvTypes: dmvInstructionNames(tx),
  }));

  return groupIntoSessions(parsedTxs);
}

/** All DMV instruction names present in a tx (top-level + inner), by discriminator. */
function dmvInstructionNames(tx: HeliusTx): string[] {
  const names: string[] = [];
  const scan = (ixs?: Array<{ programId: string; data?: string }>) => {
    for (const ix of ixs ?? []) {
      if (ix.programId !== PROGRAM_ID || !ix.data) continue;
      try {
        const bytes = bs58.decode(ix.data);
        if (bytes.length < 8) continue;
        const hex = Buffer.from(bytes.slice(0, 8)).toString('hex');
        const name = DISCRIMINATOR[hex];
        if (name) names.push(name);
      } catch {
        // not base58 / unparseable — skip
      }
    }
  };
  scan(tx.instructions);
  for (const ix of tx.instructions ?? []) scan(ix.innerInstructions);
  return names;
}

interface ParsedTx extends HeliusTx {
  dmvTypes: string[];
}

/** Most display-worthy instruction when a tx bundles several (e.g. fast-path claim). */
function primaryType(types: string[]): string {
  for (const t of PRIORITY) if (types.includes(t)) return t;
  return types[0] ?? 'Unknown';
}

// Group execution txs into sessions — one per begin_execution (separates any
// re-executions on the same vault PDA over time). finalize_execution marks the
// session's completion time + representative signature.
function groupIntoSessions(txs: ParsedTx[]): ExecutionSummary[] {
  const sorted = [...txs].sort((a, b) => a.timestamp - b.timestamp);
  const sessions: ExecutionSummary[] = [];
  let cur: ExecutionSummary | null = null;

  for (const tx of sorted) {
    if (!tx.dmvTypes.some((t) => EXECUTION_INSTRUCTIONS.has(t))) continue;

    if (tx.dmvTypes.includes('begin_execution') && cur) {
      sessions.push(cur);
      cur = null;
    }
    if (!cur) {
      cur = {
        executedAt: tx.timestamp,
        recordTxSignature: tx.signature,
        steps: [],
        totalSolDistributed: 0,
        tokenTransferCount: 0,
      };
    }

    const step = buildStep(tx);
    cur.steps.push(step);
    if (step.solAmount) cur.totalSolDistributed += step.solAmount;
    if (step.tokenAmount) cur.tokenTransferCount += 1;
    if (tx.dmvTypes.includes('finalize_execution')) {
      cur.executedAt = tx.timestamp;
      cur.recordTxSignature = tx.signature;
    }
  }
  if (cur) sessions.push(cur);

  return sessions.reverse(); // newest first
}

function buildStep(tx: ParsedTx): HistoryStep {
  const type = primaryType(tx.dmvTypes);
  let description = LABEL[type] ?? type;
  let solAmount: number | undefined;
  let tokenMint: string | undefined;
  let tokenAmount: number | undefined;

  // SOL that left the vault (outgoing native transfers not originated by the payer).
  const outSol = (tx.nativeTransfers ?? [])
    .filter((t) => t.fromUserAccount !== tx.feePayer && t.amount > 0)
    .reduce((sum, t) => sum + t.amount, 0);
  if (outSol > 0) {
    solAmount = outSol / 1e9;
    description = `${solAmount.toFixed(4)} SOL distributed`;
  }

  const outToken = (tx.tokenTransfers ?? []).find((t) => t.tokenAmount > 0);
  if (outToken) {
    tokenMint = outToken.mint;
    tokenAmount = outToken.tokenAmount;
    const dest = outToken.toUserAccount;
    description = `${tokenAmount} token${tokenAmount === 1 ? '' : 's'} to ${dest.slice(0, 4)}…${dest.slice(-4)}`;
  }

  return { type, txSignature: tx.signature, timestamp: tx.timestamp, description, solAmount, tokenMint, tokenAmount };
}
