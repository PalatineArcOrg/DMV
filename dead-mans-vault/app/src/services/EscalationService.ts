import { EscalationStage, EscalationConfig } from '../types';
import { HeartbeatService } from './HeartbeatService';
import { NotificationService } from '../notifications/NotificationService';
import { useEscalationStore } from '../store/useEscalationStore';
import { useDemoStore } from '../store/useDemoStore';

// Notification frequency caps (seconds)
const NOTIFICATION_INTERVALS: Record<number, number> = {
  1: 8 * 3600,  // Stage 1: every 8 hours
  2: 4 * 3600,  // Stage 2: every 4 hours
  3: 1 * 3600,  // Stage 3: every 1 hour
};

// Dev mode: fast notification intervals for testing
const DEV_NOTIFICATION_INTERVALS: Record<number, number> = {
  1: 15,  // 15 seconds
  2: 10,
  3: 5,
};

export class EscalationService {
  private heartbeatService: HeartbeatService;
  private config: EscalationConfig;
  private evaluationInterval: ReturnType<typeof setInterval> | null = null;
  private currentStage: EscalationStage = 0;
  private executionCallback: (() => void) | null = null;

  constructor(heartbeatService: HeartbeatService, config: EscalationConfig) {
    this.heartbeatService = heartbeatService;
    this.config = config;
  }

  setExecutionCallback(callback: () => void): void {
    this.executionCallback = callback;
  }

  start(): void {
    if (this.evaluationInterval) return;

    // Run first evaluation immediately
    this.evaluate();

    // Then evaluate every 60s (10s in dev/demo mode for faster testing)
    const useDevTimers = __DEV__ || useDemoStore.getState().isDemoMode;
    const intervalMs = useDevTimers ? 10_000 : 60_000;
    this.evaluationInterval = setInterval(() => {
      this.evaluate();
    }, intervalMs);
  }

  stop(): void {
    if (this.evaluationInterval) {
      clearInterval(this.evaluationInterval);
      this.evaluationInterval = null;
    }
  }

  async evaluate(): Promise<void> {
    try {
      const status = await this.heartbeatService.getStatus();

      // No heartbeat recorded yet — don't escalate
      if (status.lastHeartbeat === 0) return;

      if (!status.isOverdue) {
        if (this.currentStage > 0) {
          this.resetEscalation();
        }
        return;
      }

      const newStage = this.calculateStage(status.secondsOverdue);

      if (newStage !== this.currentStage) {
        this.transitionTo(newStage, status.secondsOverdue);
      } else if (newStage > 0) {
        this.sendStageNotifications(newStage, status.secondsOverdue);
      }
    } catch {
      // Evaluation failure is non-fatal — will retry on next interval
    }
  }

  calculateStage(secondsOverdue: number): EscalationStage {
    if (secondsOverdue <= 0) return 0;

    const s1End = this.config.stage1Duration;
    const s2End = s1End + this.config.stage2Duration;
    const s3End = s2End + this.config.stage3Duration;

    if (secondsOverdue < s1End) return 1;
    if (secondsOverdue < s2End) return 2;
    if (secondsOverdue < s3End) return 3;
    return 4;
  }

  private transitionTo(newStage: EscalationStage, secondsOverdue: number): void {
    this.currentStage = newStage;
    const store = useEscalationStore.getState();

    store.setStage(newStage);

    if (newStage === 4) {
      // Calculate and store execution deadline
      const totalGrace =
        this.config.stage1Duration +
        this.config.stage2Duration +
        this.config.stage3Duration;
      store.setExecutionDeadline(Math.floor(Date.now() / 1000));
    }

    // Fire stage-entry notification
    switch (newStage) {
      case 0:
        NotificationService.cancelAll();
        break;
      case 1:
        NotificationService.sendHeartbeatReminder();
        store.recordNotification();
        break;
      case 2:
        NotificationService.sendEmergencyAlert();
        store.recordNotification();
        break;
      case 3: {
        const totalGrace =
          this.config.stage1Duration +
          this.config.stage2Duration +
          this.config.stage3Duration;
        const secondsRemaining = Math.max(0, totalGrace - secondsOverdue);
        NotificationService.sendFinalWarning(secondsRemaining);
        store.recordNotification();
        break;
      }
      case 4:
        NotificationService.sendExecutionStarted();
        store.recordNotification();
        if (this.executionCallback) {
          this.executionCallback();
        }
        break;
    }
  }

  private sendStageNotifications(
    stage: EscalationStage,
    secondsOverdue: number,
  ): void {
    if (stage === 0 || stage === 4) return;

    const store = useEscalationStore.getState();
    const { lastNotificationAt } = store.state;
    const now = Math.floor(Date.now() / 1000);

    const useDevTimers = __DEV__ || useDemoStore.getState().isDemoMode;
    const intervals = useDevTimers ? DEV_NOTIFICATION_INTERVALS : NOTIFICATION_INTERVALS;
    const minInterval = intervals[stage] ?? 3600;

    if (lastNotificationAt && now - lastNotificationAt < minInterval) {
      return; // Too soon, skip
    }

    switch (stage) {
      case 1:
        NotificationService.sendHeartbeatReminder();
        break;
      case 2:
        NotificationService.sendUrgentReminder(secondsOverdue);
        break;
      case 3: {
        const totalGrace =
          this.config.stage1Duration +
          this.config.stage2Duration +
          this.config.stage3Duration;
        const secondsRemaining = Math.max(0, totalGrace - secondsOverdue);
        NotificationService.sendFinalWarning(secondsRemaining);
        break;
      }
    }

    store.recordNotification();
  }

  resetEscalation(): void {
    this.currentStage = 0;
    useEscalationStore.getState().reset();
    NotificationService.cancelAll();
  }

  getCurrentStage(): EscalationStage {
    return this.currentStage;
  }

  getSecondsRemaining(secondsOverdue: number): number {
    const totalGrace =
      this.config.stage1Duration +
      this.config.stage2Duration +
      this.config.stage3Duration;
    return Math.max(0, totalGrace - secondsOverdue);
  }
}
