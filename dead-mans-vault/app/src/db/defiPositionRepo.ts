import { PublicKey } from '@solana/web3.js';
import { getDb } from './database';
import {
  DeFiPosition,
  DeFiPositionAction,
  ClosureStrategy,
  DeFiProtocol,
  TokenBalance,
} from '../types/defi';

interface DefiPositionRow {
  id: number;
  owner_wallet: string;
  protocol: string;
  type: string;
  description: string;
  estimated_value_usd: number;
  estimated_value_sol: number;
  action: string;
  account_address: string;
  closure_strategy: string;
  token_mint: string | null;
  token_amount: number | null;
  token_decimals: number | null;
  tokens_json: string | null;
  updated_at: number;
}

export async function saveDefiPositions(
  ownerWallet: string,
  positions: DeFiPosition[],
): Promise<void> {
  const db = getDb();
  await db.runAsync('DELETE FROM defi_positions WHERE owner_wallet = ?', [ownerWallet]);

  for (const pos of positions) {
    const tokensJson =
      pos.tokens.length > 0
        ? JSON.stringify(
            pos.tokens.map((t) => ({
              mint: t.mint.toString(),
              symbol: t.symbol,
              amount: t.amount,
              decimals: t.decimals,
              usdValue: t.usdValue,
            })),
          )
        : null;

    await db.runAsync(
      `INSERT INTO defi_positions
        (owner_wallet, protocol, type, description, estimated_value_usd,
         estimated_value_sol, action, account_address, closure_strategy,
         token_mint, token_amount, token_decimals, tokens_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ownerWallet,
        pos.protocol,
        pos.type,
        pos.description,
        pos.estimatedValueUsd,
        pos.estimatedValueSol,
        pos.action,
        pos.accountAddress.toString(),
        pos.closureStrategy,
        pos.tokenMint ?? null,
        pos.tokenAmount ?? null,
        pos.tokenDecimals ?? null,
        tokensJson,
      ],
    );
  }
}

export async function getDefiPositions(
  ownerWallet: string,
): Promise<DeFiPosition[]> {
  const db = getDb();
  const rows = await db.getAllAsync<DefiPositionRow>(
    'SELECT * FROM defi_positions WHERE owner_wallet = ? ORDER BY id ASC',
    [ownerWallet],
  );

  return rows.map((row) => {
    let tokens: TokenBalance[] = [];
    if (row.tokens_json) {
      try {
        const parsed = JSON.parse(row.tokens_json);
        tokens = parsed.map((t: any) => ({
          mint: new PublicKey(t.mint),
          symbol: t.symbol,
          amount: t.amount,
          decimals: t.decimals,
          usdValue: t.usdValue,
        }));
      } catch {
        // Ignore malformed JSON
      }
    }

    return {
      protocol: row.protocol as DeFiProtocol,
      type: row.type,
      description: row.description,
      estimatedValueUsd: row.estimated_value_usd,
      estimatedValueSol: row.estimated_value_sol,
      tokens,
      action: row.action as DeFiPositionAction,
      accountAddress: new PublicKey(row.account_address),
      closureStrategy: row.closure_strategy as ClosureStrategy,
      tokenMint: row.token_mint ?? undefined,
      tokenAmount: row.token_amount ?? undefined,
      tokenDecimals: row.token_decimals ?? undefined,
    };
  });
}

export async function clearDefiPositions(ownerWallet: string): Promise<void> {
  const db = getDb();
  await db.runAsync('DELETE FROM defi_positions WHERE owner_wallet = ?', [ownerWallet]);
}
