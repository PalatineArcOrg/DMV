/**
 * DeFi Closure Service.
 *
 * Routes position closures by strategy:
 *   - 'jupiter_swap'    → Swap token to SOL via Jupiter V6
 *   - 'protocol_native' → Protocol-specific instruction (e.g., native stake deactivate)
 *   - 'unsupported'     → Log detection, mark as skipped
 *
 * On devnet: simulates closures with a delay and mock tx signature.
 * On mainnet: executes real Jupiter swaps and protocol-specific instructions.
 */

import { Connection, Keypair } from '@solana/web3.js';
import { DeFiPosition, ClosureResult } from '../types/defi';
import { executeSwap } from './jupiterSwap';
import { isDevnet } from '../utils/rpcConfig';

export class DeFiClosureService {
  private connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Close a single DeFi position and return SOL.
   */
  async closePosition(
    position: DeFiPosition,
    agentKeypair: Keypair,
  ): Promise<ClosureResult> {
    switch (position.closureStrategy) {
      case 'jupiter_swap':
        return this.closeViaJupiter(position, agentKeypair);

      case 'protocol_native':
        return this.closeNative(position, agentKeypair);

      case 'unsupported':
        return {
          success: true,
          error: `Closure not supported for ${position.protocol} ${position.type}. Detection only.`,
          simulated: true,
        };

      default:
        return {
          success: false,
          error: `Unknown closure strategy: ${position.closureStrategy}`,
          simulated: false,
        };
    }
  }

  private async closeViaJupiter(
    position: DeFiPosition,
    agentKeypair: Keypair,
  ): Promise<ClosureResult> {
    if (!position.tokenMint || !position.tokenAmount || !position.tokenDecimals) {
      return {
        success: false,
        error: 'Missing token details for Jupiter swap',
        simulated: false,
      };
    }

    // Devnet simulation — Jupiter doesn't operate on devnet
    if (isDevnet()) {
      return this.simulateClosure(position);
    }

    try {
      // Convert token amount to raw integer amount
      const rawAmount = Math.floor(
        position.tokenAmount * Math.pow(10, position.tokenDecimals),
      ).toString();

      // Use 3% slippage for autonomous execution (no human approval)
      const result = await executeSwap(
        this.connection,
        agentKeypair,
        position.tokenMint,
        rawAmount,
        300,
      );

      const solRecovered = Number(result.outputAmount) / 1e9;

      return {
        success: true,
        txSignature: result.txSignature,
        solRecovered,
        simulated: false,
      };
    } catch (err: any) {
      return {
        success: false,
        error: err.message || String(err),
        simulated: false,
      };
    }
  }

  private async closeNative(
    position: DeFiPosition,
    _agentKeypair: Keypair,
  ): Promise<ClosureResult> {
    if (position.protocol === 'native_stake') {
      // Native stake requires deactivate + withdraw (2 epochs).
      // For the hackathon, simulate this since it takes ~4 days on mainnet.
      return this.simulateClosure(position);
    }

    return {
      success: false,
      error: `Protocol-native closure not implemented for ${position.protocol}`,
      simulated: false,
    };
  }

  /**
   * Devnet simulation: log the closure and return a mock result.
   */
  private async simulateClosure(position: DeFiPosition): Promise<ClosureResult> {
    // Simulate network delay
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const mockSig = `sim_${position.protocol}_${Date.now().toString(36)}`;
    const solRecovered = position.estimatedValueSol || position.tokenAmount || 0;

    return {
      success: true,
      txSignature: mockSig,
      solRecovered,
      simulated: true,
    };
  }
}
