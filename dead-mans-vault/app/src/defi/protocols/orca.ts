/**
 * Detector for Orca Whirlpool concentrated liquidity positions.
 *
 * Detection approach:
 *   1. Get wallet's token accounts (amount=1, decimals=0 → NFT candidates)
 *   2. Derive Position PDA for each NFT mint: seeds = ["position", mint_pubkey]
 *   3. Batch-fetch Position PDAs — valid ones are Whirlpool positions
 *   4. Fetch the Whirlpool pool account to get token pair + current tick
 *   5. Build rich description with token pair, tick range, fee tier, in/out-of-range
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { DeFiPosition } from '../../types/defi';
import { KNOWN_TOKEN_SYMBOLS } from '../registry';

const ORCA_WHIRLPOOL_MAINNET = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const ORCA_WHIRLPOOL_DEVNET = new PublicKey('2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ');

const DISCRIMINATOR_SIZE = 8;

// Position account offsets (after 8-byte Anchor discriminator)
const POS_WHIRLPOOL_OFFSET = 0;
const POS_MINT_OFFSET = 32;
const POS_LIQUIDITY_OFFSET = 64;
const POS_TICK_LOWER_OFFSET = 80;
const POS_TICK_UPPER_OFFSET = 84;
const POSITION_DATA_SIZE = 216;

// Whirlpool pool account offsets (after 8-byte discriminator)
const POOL_FEE_RATE_OFFSET = 37;
const POOL_TICK_CURRENT_OFFSET = 73;
const POOL_TOKEN_MINT_A_OFFSET = 93;
const POOL_TOKEN_MINT_B_OFFSET = 173;

function getWhirlpoolProgram(connection: Connection): PublicKey {
  const endpoint = connection.rpcEndpoint.toLowerCase();
  return endpoint.includes('devnet') ? ORCA_WHIRLPOOL_DEVNET : ORCA_WHIRLPOOL_MAINNET;
}

function readPublicKey(data: Buffer, offset: number): PublicKey {
  return new PublicKey(data.subarray(offset, offset + 32));
}

function readI32(data: Buffer, offset: number): number {
  return data.readInt32LE(offset);
}

function readU16(data: Buffer, offset: number): number {
  return data.readUInt16LE(offset);
}

/** Read u128 as a JS number without BigInt (Hermes compatibility). Lossy but fine for display. */
function readU128AsNumber(data: Buffer, offset: number): number {
  // Read as four 32-bit chunks to avoid BigInt (unavailable in Hermes)
  const lo32 = data.readUInt32LE(offset);
  const loHi32 = data.readUInt32LE(offset + 4);
  const hi32 = data.readUInt32LE(offset + 8);
  const hiHi32 = data.readUInt32LE(offset + 12);
  // Combine — lossy for > 2^53 but acceptable for display purposes
  return lo32 + loHi32 * 2 ** 32 + hi32 * 2 ** 64 + hiHi32 * 2 ** 96;
}

function getSymbol(mint: PublicKey): string {
  const mintStr = mint.toBase58();
  return KNOWN_TOKEN_SYMBOLS[mintStr]?.symbol ?? mintStr.slice(0, 6);
}

function formatLiquidity(liq: number): string {
  if (liq >= 1e12) return `${(liq / 1e12).toFixed(2)}T`;
  if (liq >= 1e9) return `${(liq / 1e9).toFixed(2)}B`;
  if (liq >= 1e6) return `${(liq / 1e6).toFixed(2)}M`;
  if (liq >= 1e3) return `${(liq / 1e3).toFixed(1)}K`;
  return liq.toFixed(0);
}

function formatFeeRate(bps: number): string {
  const pct = bps / 10000;
  return `${pct.toFixed(2)}%`;
}

export async function detectOrca(
  connection: Connection,
  wallet: PublicKey,
): Promise<DeFiPosition[]> {
  const positions: DeFiPosition[] = [];
  const programId = getWhirlpoolProgram(connection);

  try {
    // Step 1: Get wallet's token accounts — filter for NFT-like (amount=1)
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet, {
      programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    });

    const nftMints: PublicKey[] = [];
    for (const { account } of tokenAccounts.value) {
      const parsed = account.data.parsed?.info;
      if (!parsed) continue;
      const amount = parsed.tokenAmount;
      // NFT: exactly 1 token, 0 decimals
      if (Number(amount.amount) === 1 && amount.decimals === 0) {
        nftMints.push(new PublicKey(parsed.mint));
      }
    }

    if (nftMints.length === 0) return positions;

    // Step 2: Derive Position PDAs for each NFT mint
    const positionPdas = nftMints.map((mint) =>
      PublicKey.findProgramAddressSync(
        [Buffer.from('position'), mint.toBuffer()],
        programId,
      )[0],
    );

    // Step 3: Batch-fetch Position accounts
    const positionAccounts = await connection.getMultipleAccountsInfo(positionPdas);

    // Step 4: Parse valid positions and collect unique whirlpool addresses
    interface ParsedPosition {
      positionPda: PublicKey;
      positionMint: PublicKey;
      whirlpool: PublicKey;
      liquidity: number;
      tickLower: number;
      tickUpper: number;
    }

    const parsed: ParsedPosition[] = [];
    const whirlpoolSet = new Set<string>();

    for (let i = 0; i < positionAccounts.length; i++) {
      const acct = positionAccounts[i];
      if (!acct || acct.data.length < DISCRIMINATOR_SIZE + POSITION_DATA_SIZE) continue;
      // Verify it's owned by the Whirlpool program
      if (!acct.owner.equals(programId)) continue;

      const data = Buffer.from(acct.data);
      const d = DISCRIMINATOR_SIZE;

      const whirlpool = readPublicKey(data, d + POS_WHIRLPOOL_OFFSET);
      const positionMint = readPublicKey(data, d + POS_MINT_OFFSET);
      const liquidity = readU128AsNumber(data, d + POS_LIQUIDITY_OFFSET);
      const tickLower = readI32(data, d + POS_TICK_LOWER_OFFSET);
      const tickUpper = readI32(data, d + POS_TICK_UPPER_OFFSET);

      parsed.push({
        positionPda: positionPdas[i],
        positionMint,
        whirlpool,
        liquidity,
        tickLower,
        tickUpper,
      });
      whirlpoolSet.add(whirlpool.toBase58());
    }

    if (parsed.length === 0) return positions;

    // Step 5: Fetch Whirlpool pool accounts for token pair info
    const whirlpoolKeys = Array.from(whirlpoolSet).map((k) => new PublicKey(k));
    const poolAccounts = await connection.getMultipleAccountsInfo(whirlpoolKeys);

    interface PoolInfo {
      tokenMintA: PublicKey;
      tokenMintB: PublicKey;
      feeRate: number;
      tickCurrent: number;
    }

    const poolMap = new Map<string, PoolInfo>();
    for (let i = 0; i < poolAccounts.length; i++) {
      const acct = poolAccounts[i];
      if (!acct || acct.data.length < DISCRIMINATOR_SIZE + 205) continue;

      const data = Buffer.from(acct.data);
      const d = DISCRIMINATOR_SIZE;

      poolMap.set(whirlpoolKeys[i].toBase58(), {
        tokenMintA: readPublicKey(data, d + POOL_TOKEN_MINT_A_OFFSET),
        tokenMintB: readPublicKey(data, d + POOL_TOKEN_MINT_B_OFFSET),
        feeRate: readU16(data, d + POOL_FEE_RATE_OFFSET),
        tickCurrent: readI32(data, d + POOL_TICK_CURRENT_OFFSET),
      });
    }

    // Step 6: Build rich DeFiPosition entries
    for (const pos of parsed) {
      const pool = poolMap.get(pos.whirlpool.toBase58());
      const symbolA = pool ? getSymbol(pool.tokenMintA) : '???';
      const symbolB = pool ? getSymbol(pool.tokenMintB) : '???';
      const feeStr = pool ? formatFeeRate(pool.feeRate) : '';
      const inRange = pool
        ? pos.tickLower <= pool.tickCurrent && pool.tickCurrent < pos.tickUpper
        : false;
      const rangeLabel = pool ? (inRange ? 'In Range' : 'Out of Range') : '';
      const liqStr = formatLiquidity(pos.liquidity);

      const parts = [`${symbolA}/${symbolB} Concentrated LP`];
      if (feeStr) parts.push(`${feeStr} fee`);
      if (rangeLabel) parts.push(rangeLabel);
      parts.push(`Liquidity: ${liqStr}`);

      positions.push({
        protocol: 'orca',
        type: 'whirlpool_position',
        description: parts.join(' · '),
        estimatedValueUsd: 0,
        estimatedValueSol: 0,
        tokens: pool
          ? [
              { mint: pool.tokenMintA, symbol: symbolA, amount: 0, decimals: 0, usdValue: 0 },
              { mint: pool.tokenMintB, symbol: symbolB, amount: 0, decimals: 0, usdValue: 0 },
            ]
          : [],
        action: 'close',
        accountAddress: pos.positionPda,
        closureStrategy: 'unsupported',
        tokenMint: pos.positionMint.toBase58(),
      });
    }
  } catch {
    // Whirlpool scan failure is non-fatal
  }

  return positions;
}
