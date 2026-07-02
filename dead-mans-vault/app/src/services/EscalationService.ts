import { EscalationStage, EscalationConfig } from '../types';
import { HeartbeatService } from './HeartbeatService';
import { NotificationService, formatDuration } from '../notifications/NotificationService';
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
  private beneficiaryCount: number = 0;
  // When the FCM notify-server is confirmed watching this vault, IT delivers the
  // stage 1-3 escalation alerts — so we must NOT also fire the local pre-scheduled
  // timeline, or the user gets two notifications per stage. The local timeline is
  // scheduled provisionally and used ONLY as a fallback when FCM isn't active.
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
   * When FCM is active, the server is the single source of escalation alerts, so
   * we cancel the local pre-scheduled timeline to avoid duplicate notifications.
   * When it's not (no push token / no server / register failed), we (re)schedule
   * the local timeline as the fallback.
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
   * Materialize the entire future escalation sequence as OS-scheduled
   * notifications. Because the timeline is fully deterministic from the last
   * heartbeat (nextDue + stage durations) and the device clock, every stage
   * entry and recurring reminder can be scheduled up-front — so the user is
   * warned on time even if the app is never reopened. Called on mount and on
   * every heartbeat confirmation; each call replaces the prior timeline.
   */
  async scheduleBackgroundTimeline(): Promise<void> {
    // FCM notify-server is the escalation-alert source when active — don't also
    // schedule the local timeline (would double every stage notification).
    if (this.fcmActive) {
      await NotificationService.cancelEscalationTimeline();
      return;
    }

    const status = await this.heartbeatService.getStatus();

    // No heartbeat yet, or no valid due time — clear any stale timeline.
    if (status.lastHeartbeat === 0 || !status.nextDue) {
      await NotificationService.cancelEscalationTimeline();
      return;
    }

    const useDevTimers = __DEV__ || useDemoStore.getState().isDemoMode;
    const intervals = useDevTimers ? DEV_NOTIFICATION_INTERVALS : NOTIFICATION_INTERVALS;

    const s1 = this.config.stage1Duration;
    const s2 = this.config.stage2Duration;
    const s3 = this.config.stage3Duration;
    const totalGrace = s1 + s2 + s3;
    const dueAt = status.nextDue; // absolute unix ts when stage 1 begins
    const now = Math.floor(Date.now() / 1000);

    const bText =
      this.beneficiaryCount > 0
        ? ` ${this.beneficiaryCount} beneficiar${this.beneficiaryCount !== 1 ? 'ies' : 'y'} affected.`
        : '';

    type Ev = { at: number; entry: boolean; title: string; body: string; channelId: string };
    const events: Ev[] = [];

    const addStage = (
      stage: 1 | 2 | 3,
      stageStart: number,
      stageDuration: number,
      title: string,
      channelId: string,
      bodyFor: (at: number) => string,
    ) => {
      const interval = intervals[stage] ?? 3600;
      // Stage entry, then recurring reminders until the stage ends.
      for (let at = stageStart, first = true; at < stageStart + stageDuration; at += interval, first = false) {
        events.push({ at, entry: first, title, body: bodyFor(at), channelId });
      }
    };

    addStage(1, dueAt, s1, 'Heartbeat Due', 'heartbeat',
      () => 'Your vault heartbeat is overdue. Open the app to confirm and keep your vault active.');
    addStage(2, dueAt + s1, s2, 'Heartbeat Overdue', 'escalation',
      () => `Emergency escalation active.${bText} Open the app to confirm.`);
    addStage(3, dueAt + s1 + s2, s3, 'FINAL WARNING', 'execution',
      (at) => `Estate plan executes in ${formatDuration(Math.max(0, dueAt + totalGrace - at))}. Confirm heartbeat NOW.`);

    // Stage 4: grace elapsed. Execution itself requires the app to run, so this
    // prompts the user to open it.
    events.push({
      at: dueAt + totalGrace,
      entry: true,
      title: 'Estate Plan Due',
      body: 'Grace period has elapsed. Open Dead Man’s Vault to begin distribution to your beneficiaries.',
      channelId: 'execution',
    });

    // Keep only future events, soonest first.
    const future = events.filter((e) => e.at > now).sort((a, b) => a.at - b.at);

    // Bound to the OS limit: always keep stage-entry events; evenly downsample
    // the recurring reminders to fill the remaining budget so coverage spans
    // the whole grace window instead of clustering at the start.
    const MAX = NotificationService.MAX_ESCALATION_NOTIFS;
    let selected = future;
    if (future.length > MAX) {
      const entries = future.filter((e) => e.entry);
      const recurs = future.filter((e) => !e.entry);
      const budget = Math.max(0, MAX - entries.length);
      const step = recurs.length / budget;
      const sampledRecurs = budget > 0
        ? Array.from({ length: budget }, (_, i) => recurs[Math.floor(i * step)])
        : [];
      selected = [...entries, ...sampledRecurs].sort((a, b) => a.at - b.at);
    }

    await NotificationService.scheduleEscalationTimeline(
      selected.map((e) => ({
        title: e.title,
        body: e.body,
        channelId: e.channelId,
        delaySeconds: e.at - now,
      })),
    );
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
