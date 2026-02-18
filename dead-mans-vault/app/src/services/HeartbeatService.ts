import { Connection, PublicKey } from '@solana/web3.js';
import { HeartbeatMethod, HeartbeatConfig, HeartbeatStatus } from '../types';
import {
  recordHeartbeat,
  getLastHeartbeat,
  getHeartbeatCount,
} from '../db/heartbeatRepo';
import { useHeartbeatStore } from '../store/useHeartbeatStore';

export class HeartbeatService {
  private config: HeartbeatConfig;
  private monitoringInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: HeartbeatConfig) {
    this.config = config;
  }

  updateConfig(config: HeartbeatConfig): void {
    this.config = config;
  }

  async confirmHeartbeat(method: HeartbeatMethod): Promise<void> {
    await recordHeartbeat(method);
    const status = await this.getStatus();
    useHeartbeatStore.getState().setStatus(status);
  }

  async getStatus(): Promise<HeartbeatStatus> {
    const last = await getLastHeartbeat();
    const totalCount = await getHeartbeatCount();

    if (!last) {
      return {
        lastHeartbeat: 0,
        lastMethod: 'active_tap',
        totalHeartbeats: 0,
        nextDue: 0,
        isOverdue: false,
        secondsOverdue: 0,
      };
    }

    const now = Math.floor(Date.now() / 1000);
    const nextDue = last.timestamp + this.config.intervalSeconds;
    const secondsOverdue = Math.max(0, now - nextDue);

    return {
      lastHeartbeat: last.timestamp,
      lastMethod: (last.method as HeartbeatMethod) || 'active_tap',
      totalHeartbeats: totalCount,
      nextDue,
      isOverdue: secondsOverdue > 0,
      secondsOverdue,
    };
  }

  startOnChainMonitoring(
    connection: Connection,
    ownerPubkey: PublicKey,
    intervalMs: number = 60000,
  ): void {
    if (!this.config.methods.includes('on_chain_activity')) return;
    if (this.monitoringInterval) return;

    this.monitoringInterval = setInterval(async () => {
      try {
        const signatures = await connection.getSignaturesForAddress(
          ownerPubkey,
          { limit: 5 },
        );
        if (signatures.length === 0) return;

        // Filter to transactions where the owner was a signer (not just a participant).
        // getSignaturesForAddress returns all txs involving the address, including
        // incoming transfers. We need to verify the owner actually signed the tx.
        let ownerSignedTx: { blockTime: number } | null = null;
        for (const sig of signatures) {
          if (!sig.blockTime || sig.err) continue;
          try {
            const tx = await connection.getTransaction(sig.signature, {
              maxSupportedTransactionVersion: 0,
            });
            if (!tx?.transaction?.message) continue;
            const accountKeys = tx.transaction.message.staticAccountKeys
              ?? (tx.transaction.message as any).accountKeys ?? [];
            const signerCount = tx.transaction.message.header?.numRequiredSignatures
              ?? (tx.transaction.message as any).numRequiredSignatures ?? 1;
            // Signers are the first N accounts in the account keys list
            const signers = accountKeys.slice(0, signerCount).map((k: any) => k.toString());
            if (signers.includes(ownerPubkey.toString())) {
              ownerSignedTx = { blockTime: sig.blockTime };
              break;
            }
          } catch {
            // Skip this tx if we can't fetch details
          }
        }

        if (!ownerSignedTx) return;

        const last = await getLastHeartbeat();
        if (!last || ownerSignedTx.blockTime > last.timestamp) {
          await this.confirmHeartbeat('on_chain_activity');
        }
      } catch {
        // On-chain monitoring failure is non-fatal
      }
    }, intervalMs);
  }

  stopOnChainMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
  }

  destroy(): void {
    this.stopOnChainMonitoring();
  }
}
