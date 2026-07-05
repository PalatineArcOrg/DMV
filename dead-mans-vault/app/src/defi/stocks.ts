import { PublicKey } from '@solana/web3.js';

/**
 * Tokenized-stock (RWA) support. Tokenized equities on Solana — Backed "xStocks"
 * and Backpack Securities / Sunrise — are Token-2022 mints. The portfolio scanner
 * does not record a token's owning program, so classification relies on a known
 * mint list (below) plus an xStock-style symbol heuristic. See
 * tasks/TOKEN2022-RWA-SUPPORT.md for the on-chain verification.
 */
export const KNOWN_STOCK_MINTS: Record<string, { symbol: string; name: string }> = {
  // --- Backed xStocks (mainnet) ---
  XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB: { symbol: 'TSLAx', name: 'Tesla xStock' },
  XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp: { symbol: 'AAPLx', name: 'Apple xStock' },
  // --- Backpack Securities / Sunrise (mainnet) ---
  SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb: { symbol: 'SPCX', name: 'SpaceX (Backpack)' },
  SNDKbwMUQvZhnLnxLduradgLHG5KrPuKwpnrkkGRhfH: { symbol: 'SNDK', name: 'SanDisk (Backpack)' },
  // --- DMV devnet test stocks (minted for on-device testing) ---
  '5vENRu8q3PFLCSfKwbcuWArX29Z139BFWNPFN5ytKrZz': { symbol: 'TSLAx', name: 'Tesla xStock (test)' },
  Fmig3ToxDytDh5HRkHWVbPnZawoBJeKpwDU14WFs5xRi: { symbol: 'AAPLx', name: 'Apple xStock (test)' },
  '3UxCSgNYLGdSPVizcmRxYS3wFf1gLw4T9AbfNNzBNEiG': { symbol: 'SPCXt', name: 'SpaceX (test)' },
  GtedZCi6MiSwZSdSRYFHnE1uYt1cSSbqhtX7XuQ54W8b: { symbol: 'NVDAx', name: 'Nvidia xStock (test)' },
  EXH8m657MQ7hUvwS8kXUztwUdJpZ2CxKD7QMTcWyoyB3: { symbol: 'MSFTx', name: 'Microsoft xStock (test)' },
  EVJUoLBhg3qWpfF3SnM5A55YKWNU94Bn2caDfquMq9Rv: { symbol: 'GOOGLx', name: 'Alphabet xStock (test)' },
};

// xStock-style tickers: 2-6 uppercase letters + a trailing lowercase 'x'
// (TSLAx, AAPLx, GOOGLx, NVDAx). Backpack tickers (SPCX/SNDK) are caught by the mint list.
const XSTOCK_SYMBOL = /^[A-Z]{2,6}x$/;

function mintStr(mint: PublicKey | string | undefined): string | undefined {
  if (!mint) return undefined;
  return typeof mint === 'string' ? mint : mint.toBase58?.();
}

/** Classify a fungible token as a tokenized stock (never an NFT). */
export function isStock(t: { mint?: PublicKey | string; symbol?: string; isNft?: boolean }): boolean {
  if (t.isNft) return false;
  const m = mintStr(t.mint);
  if (m && KNOWN_STOCK_MINTS[m]) return true;
  return XSTOCK_SYMBOL.test((t.symbol || '').trim());
}

/** Curated symbol/name for a known stock mint, if any. */
export function stockMeta(mint: PublicKey | string): { symbol: string; name: string } | undefined {
  const m = mintStr(mint);
  return m ? KNOWN_STOCK_MINTS[m] : undefined;
}
