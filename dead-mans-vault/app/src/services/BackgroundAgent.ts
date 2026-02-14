import { PublicKey } from '@solana/web3.js';
import { HeartbeatService } from './HeartbeatService';
import { EscalationService } from './EscalationService';
import { ExecutionService } from './ExecutionService';
import { EscalationConfig, HeartbeatConfig, Beneficiary } from '../types';
import { ESCALATION_DEFAULTS } from '../utils/constants';
import { useDemoStore } from '../store/useDemoStore';

const DEV_ESCALATION_CONFIG: EscalationConfig = {
  stage1Duration: 30,
  stage2Duration: 30,
  stage3Duration: 30,
  emergencyContacts: [],
};

export class BackgroundAgent {
  private static instance: BackgroundAgent | null = null;

  private heartbeatService: HeartbeatService | null = null;
  private escalationService: EscalationService | null = null;
  private running = false;

  static getInstance(): BackgroundAgent {
    if (!BackgroundAgent.instance) {
      BackgroundAgent.instance = new BackgroundAgent();
    }
    return BackgroundAgent.instance;
  }

  start(
    heartbeatConfig: HeartbeatConfig,
    escalationConfig?: EscalationConfig,
    ownerPubkey?: PublicKey,
    beneficiaries?: Beneficiary[],
  ): void {
    if (this.running) return;

    this.heartbeatService = new HeartbeatService(heartbeatConfig);

    const useDevTimers = __DEV__ || useDemoStore.getState().isDemoMode;
    const escConfig = escalationConfig ??
      (useDevTimers
        ? DEV_ESCALATION_CONFIG
        : {
            stage1Duration: ESCALATION_DEFAULTS.stage1,
            stage2Duration: ESCALATION_DEFAULTS.stage2,
            stage3Duration: ESCALATION_DEFAULTS.stage3,
            emergencyContacts: [],
          });

    this.escalationService = new EscalationService(
      this.heartbeatService,
      escConfig,
    );

    // Wire Stage 4 execution callback
    if (ownerPubkey && beneficiaries && beneficiaries.length > 0) {
      this.escalationService.setExecutionCallback(() => {
        const executor = new ExecutionService(ownerPubkey, beneficiaries);
        executor.execute().catch((err) => {
          console.error('ExecutionService error:', err);
        });
      });
    }

    this.escalationService.start();
    this.running = true;
  }

  stop(): void {
    if (this.escalationService) {
      this.escalationService.stop();
    }
    if (this.heartbeatService) {
      this.heartbeatService.destroy();
    }
    this.running = false;
  }

  getHeartbeatService(): HeartbeatService | null {
    return this.heartbeatService;
  }

  getEscalationService(): EscalationService | null {
    return this.escalationService;
  }

  isRunning(): boolean {
    return this.running;
  }
}
