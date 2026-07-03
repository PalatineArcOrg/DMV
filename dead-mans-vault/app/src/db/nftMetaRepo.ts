import { getDb } from './database';

/**
 * Persistent cache of NFT metadata resolved from on-chain Metaplex accounts
 * (see metaplexMetadata.ts). NFTs are immutable, so entries are cached
 * indefinitely — subsequent scans skip the metadata + image-uri fetch entirely.
 */
export interface NftMeta {
  name: string;
  symbol: string;
  image: string | null;
}

let tableReady = false;
async function ensureTable(): Promise<void> {
  if (tableReady) return;
  const db = getDb();
  await db.execAsync(
    'CREATE TABLE IF NOT EXISTS nft_meta (mint TEXT PRIMARY KEY, name TEXT, symbol TEXT, image TEXT, updated_at INTEGER)',
  );
  tableReady = true;
}

export async function getNftMeta(mint: string): Promise<NftMeta | null> {
  await ensureTable();
  const db = getDb();
  const row = await db.getFirstAsync<{ name: string; symbol: string; image: string | null }>(
    'SELECT name, symbol, image FROM nft_meta WHERE mint = ?',
    [mint],
  );
  return row ? { name: row.name, symbol: row.symbol, image: row.image } : null;
}

export async function setNftMeta(mint: string, meta: NftMeta): Promise<void> {
  await ensureTable();
  const db = getDb();
  await db.runAsync(
    'INSERT OR REPLACE INTO nft_meta (mint, name, symbol, image, updated_at) VALUES (?, ?, ?, ?, ?)',
    [mint, meta.name, meta.symbol, meta.image ?? null, Date.now()],
  );
}
