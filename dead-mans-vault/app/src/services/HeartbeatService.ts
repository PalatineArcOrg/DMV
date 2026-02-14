import { Connection, PublicKey } from '@solana/web3.js';
import { HeartbeatMethod, HeartbeatConfig, HeartbeatStatus } from '../types';
import {
  recordHeartbeat,
  getLastHeartbeat,
  getHeartbeatHistory,
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
    const history = await getHeartbeatHistory(1);
    const totalCount = (await getHeartbeatHistory(10000)).length;

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
          { limit: 1 },
        );
        if (signatures.length === 0) return;

        const latestTx = signatures[0];
        if (!latestTx.blockTime) return;

        const last = await getLastHeartbeat();
        if (!last || latestTx.blockTime > last.timestamp) {
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
