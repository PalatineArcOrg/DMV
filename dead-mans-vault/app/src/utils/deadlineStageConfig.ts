import type { EscalationConfig } from '../types';

export interface DeadlineStageDurations {
  stage1Duration: number;
  stage2Duration: number;
  stage3Duration: number;
}

export const DEMO_DEADLINE_STAGE_DURATIONS: DeadlineStageDurations = {
  stage1Duration: 30,
  stage2Duration: 30,
  stage3Duration: 30,
};

export const DEFAULT_DEADLINE_STAGE_DURATIONS: DeadlineStageDurations = {
  stage1Duration: 259_200,
  stage2Duration: 604_800,
  stage3Duration: 604_800,
};

/**
 * Returns the exact stage subdivision used both by deadline display and by
 * deliberate notify-server registration. A development build does not alter
 * vault timing; only an explicitly created demo vault uses demo durations.
 */
export function getDeadlineStageDurations(
  isDemoMode: boolean,
  configured?: Pick<
    EscalationConfig,
    'stage1Duration' | 'stage2Duration' | 'stage3Duration'
  >,
): DeadlineStageDurations {
  if (isDemoMode) {
    return { ...DEMO_DEADLINE_STAGE_DURATIONS };
  }
  if (configured) {
    return {
      stage1Duration: configured.stage1Duration,
      stage2Duration: configured.stage2Duration,
      stage3Duration: configured.stage3Duration,
    };
  }
  return { ...DEFAULT_DEADLINE_STAGE_DURATIONS };
}

export function toNotificationStageDurations(
  durations: DeadlineStageDurations,
): { stage1: number; stage2: number; stage3: number } {
  return {
    stage1: durations.stage1Duration,
    stage2: durations.stage2Duration,
    stage3: durations.stage3Duration,
  };
}
