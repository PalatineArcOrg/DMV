import { PublicKey } from '@solana/web3.js';

/**
 * Metaplex Token Metadata program + on-chain account reader.
 *
 * Lets us resolve an NFT's name / symbol / uri directly from its Metadata account
 * over ANY standard RPC — no DAS required. Used by the portfolio scanner's RPC
 * fallback so NFTs still show names/images when Helius DAS is unavailable.
 *
 * Note: compressed NFTs (cNFTs) have NO token account and NO Metadata PDA — they
 * live only in the DAS index — so this path cannot see them (DAS only).
 */
export const TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
);

export function metadataPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    TOKEN_METADATA_PROGRAM_ID,
  )[0];
}

/**
 * Manual borsh parse of a Metaplex Metadata account (no dependency).
 * Layout from offset 0: key(1) + update_authority(32) + mint(32) = 65 bytes,
 * then three borsh strings — name, symbol, uri — each `u32 LE length + utf8 bytes`.
 * Fields are fixed-capacity on-chain (name 32 / symbol 10 / uri 200) but stored as
 * their real length; we read the real length and strip trailing NUL padding.
 * Returns null on any bounds/format error.
 */
export function parseMetadataAccount(
  data: Buffer,
): { name: string; symbol: string; uri: string } | null {
  try {
    let off = 1 + 32 + 32; // key + update_authority + mint
    const readStr = (): string => {
      const len = data.readUInt32LE(off);
      off += 4;
      if (off + len > data.length) throw new Error('out of bounds');
      // Use Buffer.toString(encoding, start, end) — NOT subarray().toString('utf8'):
      // in RN's buffer polyfill, subarray() returns a plain Uint8Array whose toString
      // ignores the encoding and emits comma-joined byte codes ("68,77,86…").
      const s = data.toString('utf8', off, off + len);
      off += len;
      return s.replace(/\0+$/, '').trim();
    };
    const name = readStr();
    const symbol = readStr();
    const uri = readStr();
    return { name, symbol, uri };
  } catch {
    return null;
  }
}
