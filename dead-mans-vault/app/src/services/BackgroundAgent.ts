import { HeartbeatService } from './HeartbeatService';
import { EscalationService } from './EscalationService';
import { EscalationConfig, HeartbeatConfig } from '../types';
import { ESCALATION_DEFAULTS } from '../utils/constants';

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
  ): void {
    if (this.running) return;

    this.heartbeatService = new HeartbeatService(heartbeatConfig);

    const escConfig = escalationConfig ??
      (__DEV__
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
