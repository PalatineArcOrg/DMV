/**
 * Jupiter V6 Swap API client.
 * Used to swap DeFi tokens back to SOL during estate execution.
 *
 * API endpoints:
 *   GET  https://quote-api.jup.ag/v6/quote
 *   POST https://quote-api.jup.ag/v6/swap
 */

import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { WRAPPED_SOL_MINT } from './registry';

const JUPITER_QUOTE_URL = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP_URL = 'https://quote-api.jup.ag/v6/swap';

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  routePlan: any[];
}

export interface SwapResult {
  txSignature: string;
  inputAmount: string;
  outputAmount: string;
}

/**
 * Get a swap quote from Jupiter V6.
 */
export async function getQuote(
  inputMint: string,
  outputMint: string,
  amount: string,
  slippageBps: number = 100, // 1% default
): Promise<JupiterQuote | null> {
  try {
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount,
      slippageBps: slippageBps.toString(),
    });

    const response = await fetch(`${JUPITER_QUOTE_URL}?${params}`);
    if (!response.ok) return null;

    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Get a serialized swap transaction from Jupiter V6.
 */
export async function getSwapTransaction(
  quote: JupiterQuote,
  userPublicKey: string,
): Promise<string | null> {
  try {
    const response = await fetch(JUPITER_SWAP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
      }),
    });

    if (!response.ok) return null;

    const data = await response.json();
    return data.swapTransaction || null;
  } catch {
    return null;
  }
}

/**
 * Full pipeline: get quote → get swap tx → sign → send.
 * Returns the transaction signature and amounts.
 */
export async function executeSwap(
  connection: Connection,
  agentKeypair: Keypair,
  inputMint: string,
  amountRaw: string,
  slippageBps: number = 100,
): Promise<SwapResult> {
  // 1. Get quote
  const quote = await getQuote(inputMint, WRAPPED_SOL_MINT, amountRaw, slippageBps);
  if (!quote) {
    throw new Error(`Jupiter: no route found for ${inputMint} → SOL`);
  }

  // Validate minimum output — reject illiquid or zero-value swaps
  if (!quote.otherAmountThreshold || BigInt(quote.otherAmountThreshold) <= 0n) {
    throw new Error('Jupiter: minimum output is zero — likely illiquid pair');
  }

  // 2. Get swap transaction
  const swapTxBase64 = await getSwapTransaction(quote, agentKeypair.publicKey.toString());
  if (!swapTxBase64) {
    throw new Error('Jupiter: failed to build swap transaction');
  }

  // 3. Deserialize and sign
  const txBuffer = Buffer.from(swapTxBase64, 'base64');
  const tx = VersionedTransaction.deserialize(txBuffer);
  tx.sign([agentKeypair]);

  // 4. Send and confirm
  const txSig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  await connection.confirmTransaction(
    { signature: txSig, blockhash, lastValidBlockHeight },
    'confirmed',
  );

  return {
    txSignature: txSig,
    inputAmount: quote.inAmount,
    outputAmount: quote.outAmount,
  };
}
