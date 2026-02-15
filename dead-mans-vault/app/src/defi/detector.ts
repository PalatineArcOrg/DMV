/**
 * Unified DeFi position detection orchestrator.
 *
 * Two-layer detection:
 *   Layer 1 — Token mint matching (zero extra RPC calls for LSTs, JLP, kTokens)
 *   Layer 2 — Program account scanning (Orca, Meteora, MarginFi, Kamino Lending, Raydium CLMM)
 *
 * Also queries Helius Enhanced Transactions API to discover protocol interactions
 * that supplement the above detection layers.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { DeFiPosition, TokenBalance } from '../types/defi';
import { HELIUS_SOURCE_MAP } from './registry';

// Protocol detectors
import { detectLiquidStaking } from './protocols/liquidStaking';
import { detectNativeStake } from './protocols/nativeStake';
import { detectKamino } from './protocols/kamino';
import { detectJupiter } from './protocols/jupiter';
import { detectRaydium } from './protocols/raydium';
import { detectOrca } from './protocols/orca';
import { detectMeteora } from './protocols/meteora';
import { detectMarginFi } from './protocols/marginfi';

export class DeFiDetector {
  private connection: Connection;
  private heliusApiKey: string;

  constructor(connection: Connection, heliusApiKey: string) {
    this.connection = connection;
    this.heliusApiKey = heliusApiKey;
  }

  /**
   * Run all protocol detectors in parallel and merge results.
   * Accepts pre-fetched tokenBalances to avoid duplicate RPC calls.
   */
  async detectAll(
    wallet: PublicKey,
    tokenBalances: TokenBalance[],
  ): Promise<DeFiPosition[]> {
    const results = await Promise.allSettled([
      // Layer 1 — Token mint matching (synchronous, no RPC)
      Promise.resolve(detectLiquidStaking(wallet, tokenBalances)),
      Promise.resolve(detectJupiter(wallet, tokenBalances)),

      // Layer 1+2 — Token mints + program account scanning
      detectKamino(this.connection, wallet, tokenBalances),
      detectRaydium(this.connection, wallet, tokenBalances),

      // Layer 2 — Program account scanning only
      detectNativeStake(this.connection, wallet),
      detectOrca(this.connection, wallet),
      detectMeteora(this.connection, wallet),
      detectMarginFi(this.connection, wallet),

      // Helius Enhanced Transactions discovery
      this.detectViaHelius(wallet),
    ]);

    // Collect all fulfilled positions
    const allPositions: DeFiPosition[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        allPositions.push(...result.value);
      }
    }

    // Deduplicate by accountAddress
    return this.deduplicate(allPositions);
  }

  /**
   * Use Helius Enhanced Transactions API to discover DeFi protocol interactions.
   * Returns positions for protocols where the wallet has recent activity.
   */
  private async detectViaHelius(wallet: PublicKey): Promise<DeFiPosition[]> {
    if (!this.heliusApiKey) return [];

    try {
      const url = `https://api.helius.xyz/v0/addresses/${wallet.toString()}/transactions?api-key=${this.heliusApiKey}&limit=50`;
      const response = await fetch(url);
      if (!response.ok) return [];

      const transactions: any[] = await response.json();
      const discoveredProtocols = new Set<string>();
      const positions: DeFiPosition[] = [];

      for (const tx of transactions) {
        const source = tx.source;
        if (!source) continue;

        const protocol = HELIUS_SOURCE_MAP[source];
        if (!protocol || discoveredProtocols.has(protocol)) continue;

        discoveredProtocols.add(protocol);
        // We add a lightweight "activity detected" position for protocols
        // where we found transaction history but no on-chain position.
        // These will be deduplicated against actual positions found above.
        positions.push({
          protocol,
          type: 'activity_detected',
          description: `Recent ${source.toLowerCase()} activity detected via transaction history`,
          estimatedValueUsd: 0,
          estimatedValueSol: 0,
          tokens: [],
          action: 'ignore',
          accountAddress: wallet, // placeholder — will be deduped if real position exists
          closureStrategy: 'unsupported',
        });
      }

      return positions;
    } catch {
      return [];
    }
  }

  /**
   * Deduplicate positions by (protocol + accountAddress).
   * Real positions (with token data) take priority over activity-detected ones.
   */
  private deduplicate(positions: DeFiPosition[]): DeFiPosition[] {
    const seen = new Map<string, DeFiPosition>();

    for (const pos of positions) {
      const key = `${pos.protocol}:${pos.accountAddress.toString()}`;

      const existing = seen.get(key);
      if (!existing) {
        seen.set(key, pos);
      } else if (existing.type === 'activity_detected' && pos.type !== 'activity_detected') {
        // Real position takes priority over activity-detected
        seen.set(key, pos);
      }
    }

    // Also deduplicate: if a protocol has real positions, remove activity_detected for that protocol
    const protocolsWithRealPositions = new Set<string>();
    for (const pos of seen.values()) {
      if (pos.type !== 'activity_detected') {
        protocolsWithRealPositions.add(pos.protocol);
      }
    }

    const result: DeFiPosition[] = [];
    for (const pos of seen.values()) {
      if (pos.type === 'activity_detected' && protocolsWithRealPositions.has(pos.protocol)) {
        continue; // Skip activity hints for protocols where we found real positions
      }
      result.push(pos);
    }

    return result;
  }
}
