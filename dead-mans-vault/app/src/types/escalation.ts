import { PublicKey } from '@solana/web3.js';

export type EscalationStage = 0 | 1 | 2 | 3 | 4;

export interface EscalationState {
  stage: EscalationStage;
  stageEnteredAt: number | null;
  executionDeadline: number | null;
  lastNotificationAt: number | null;
  executionStarted: boolean;
}

export interface EscalationConfig {
  stage1Duration: number;
  stage2Duration: number;
  stage3Duration: number;
  emergencyContacts: PublicKey[];
}
