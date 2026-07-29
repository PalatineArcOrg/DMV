import { EscalationStage, EscalationConfig } from '../types';
import { HeartbeatService } from './HeartbeatService';
import { NotificationService } from '../notifications/NotificationService';
import { useEscalationStore } from '../store/useEscalationStore';
import { useDemoStore } from '../store/useDemoStore';

export class EscalationService {
  private heartbeatService: HeartbeatService;
  private config: EscalationConfig;
  private evaluationInterval: ReturnType<typeof setInterval> | null = null;
  private currentStage: EscalationStage = 0;
  private executionCallback: (() => void) | null = null;
  private beneficiaryCount: number = 0;
  // The FCM notify-server is the SOLE source of stage 1-3 escalation alerts (v1.7.3).
  // This flag records whether the server is confirmed watching this vault; it is used
  // to suppress the app's own stage-4 execution push so it can't double the server's.
  // NOTE: there is NO local escalation fallback. The local pre-scheduled timeline was
  // removed in v1.7.3 because it double-fired alongside the server, and nothing
  // re-schedules it. When this is false the owner receives NO stage 1-3 warnings from
  // the device at all — see scheduleBackgroundTimeline below.
  private fcmActive: boolean = false;

  constructor(heartbeatService: HeartbeatService, config: EscalationConfig) {
    this.heartbeatService = heartbeatService;
    this.config = config;

    // Restore current stage from Zustand to prevent re-triggering Stage 4
    // when the useEffect re-runs and creates a new EscalationService instance
    const store = useEscalationStore.getState();
    this.currentStage = store.state.stage;
  }

  setExecutionCallback(callback: () => void): void {
    this.executionCallback = callback;
  }

  setBeneficiaryCount(count: number): void {
    this.beneficiaryCount = count;
  }

  /**
   * Called with the result of registering this vault with the FCM notify-server.
   * When FCM is active the server is the single source of escalation alerts, so any
   * timeline left over from a pre-v1.7.3 build is cancelled to avoid duplicates.
   *
   * When it is NOT active this does NOT arm a fallback: scheduleBackgroundTimeline()
   * is cancel-only, so the call below merely clears stale notifications. An owner who
   * has not completed signed notification registration therefore gets NO stage 1-3
   * warnings from the device. Escalation still runs server-side for REGISTERED vaults,
   * and execution itself is unaffected (the permissionless keeper cranks from on-chain
   * state), but the local warning path does not exist.
   */
  setFcmActive(active: boolean): void {
    this.fcmActive = active;
    if (active) {
      NotificationService.cancelEscalationTimeline().catch(() => {});
    } else {
      this.scheduleBackgroundTimeline().catch(() => {});
    }
  }

  start(): void {
    if (this.evaluationInterval) return;

    // Pre-schedule the full escalation timeline to the OS so notifications
    // fire even if the app is killed. Refreshed on every mount (covers app
    // reopen and device reboot once the app is launched again).
    this.scheduleBackgroundTimeline().catch(() => {});

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

      // Stage notifications are delivered by the pre-scheduled OS timeline
      // (see scheduleBackgroundTimeline), so the live loop only reacts to
      // stage *transitions* — for UI state and the Stage 4 execution trigger.
      if (newStage !== this.currentStage) {
        this.transitionTo(newStage);
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

  private transitionTo(newStage: EscalationStage): void {
    this.currentStage = newStage;
    const store = useEscalationStore.getState();

    store.setStage(newStage);

    // Stage 1-3 entry/recurring notifications are delivered by the OS via the
    // pre-scheduled timeline (scheduleBackgroundTimeline), so they reach the
    // user even when the app is killed. The live loop only updates UI state
    // here and drives the terminal Stage 4 execution.
    if (newStage === 4) {
      // Stop the evaluation loop — Stage 4 is terminal, no further evaluation needed.
      this.stop();

      // Guard against double execution: if Stage 4 was already started (e.g. useEffect
      // re-ran and created a new EscalationService), do NOT fire the callback again.
      if (store.state.executionStarted) {
        return;
      }

      store.setExecutionStarted(true);
      // "Execution has begun" notice — but ONLY when the FCM server isn't the
      // notification source. When FCM is active the server sends its own Stage-4
      // push, so firing this too would double the notification (v1.7.2 fix).
      if (!this.fcmActive) {
        NotificationService.sendExecutionStarted().catch(() => {});
      }
      store.recordNotification();
      if (this.executionCallback) {
        this.executionCallback();
      }
    }
  }

  /**
   * CANCEL-ONLY since v1.7.3 — despite the name, this schedules nothing.
   *
   * It previously materialised the whole future escalation sequence as OS-scheduled
   * notifications, but that double-fired alongside the notify-server, which is now the
   * sole source of stage 1-3 alerts. All that remains is clearing a timeline left over
   * from a pre-v1.7.3 install. The local senders it used (scheduleEscalationTimeline,
   * sendHeartbeatReminder, sendUrgentReminder, sendFinalWarning) have no call sites.
   * Renaming this is deferred to avoid churn; treat it as cancelEscalationTimeline().
   */
  async scheduleBackgroundTimeline(): Promise<void> {
    // v1.7.3: the notify-server (FCM) is the SOLE source of escalation alerts —
    // FCM delivery is confirmed (incl. killed-app), and the local pre-scheduled
    // timeline double-fired with the server. We no longer schedule it; we only
    // clear any timeline left over from a prior app version.
    await NotificationService.cancelEscalationTimeline();
  }

  resetEscalation(): void {
    this.currentStage = 0;
    useEscalationStore.getState().reset();
    // Cancel everything first, THEN re-arm the timeline from the new due time.
    // Sequenced so cancelAll() can't wipe the freshly-scheduled notifications.
    NotificationService.cancelAll()
      .then(() => this.scheduleBackgroundTimeline())
      .catch(() => {});
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
