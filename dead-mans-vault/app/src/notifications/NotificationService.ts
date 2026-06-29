import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { SchedulableTriggerInputTypes } from 'expo-notifications';

// Show notifications when app is in foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

const CHANNELS = {
  heartbeat: 'heartbeat',
  escalation: 'escalation',
  execution: 'execution',
} as const;

export function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.max(1, seconds)}s`;
}

export class NotificationService {
  private static initialized = false;

  static async initialize(): Promise<void> {
    if (NotificationService.initialized) return;

    const { status } = await Notifications.requestPermissionsAsync();
    if (status !== 'granted') {
      return;
    }

    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(CHANNELS.heartbeat, {
        name: 'Heartbeat Reminders',
        importance: Notifications.AndroidImportance.HIGH,
        sound: 'default',
      });

      await Notifications.setNotificationChannelAsync(CHANNELS.escalation, {
        name: 'Escalation Alerts',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        sound: 'default',
      });

      await Notifications.setNotificationChannelAsync(CHANNELS.execution, {
        name: 'Execution Warnings',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 500, 250, 500],
        sound: 'default',
      });
    }

    NotificationService.initialized = true;
  }

  // --- Stage Notifications ---

  static async sendHeartbeatReminder(): Promise<void> {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Heartbeat Due',
        body: 'Your vault heartbeat is overdue. Tap to confirm and keep your vault active.',
        ...(Platform.OS === 'android' && { channelId: CHANNELS.heartbeat }),
      },
      trigger: null,
    });
  }

  static async sendUrgentReminder(secondsOverdue: number, beneficiaryCount?: number): Promise<void> {
    const overdueText = formatDuration(secondsOverdue);
    const beneficiaryText = beneficiaryCount
      ? ` ${beneficiaryCount} beneficiar${beneficiaryCount !== 1 ? 'ies' : 'y'} will receive assets if no heartbeat.`
      : '';
    await Notifications.scheduleNotificationAsync({
      content: {
        title: `Heartbeat ${overdueText} Overdue`,
        body: `Emergency escalation active.${beneficiaryText} Tap to confirm.`,
        ...(Platform.OS === 'android' && { channelId: CHANNELS.escalation }),
      },
      trigger: null,
    });
  }

  static async sendFinalWarning(secondsRemaining: number): Promise<void> {
    const timeText = formatDuration(secondsRemaining);
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'FINAL WARNING',
        body: `Estate plan executes in ${timeText}. Confirm heartbeat NOW to cancel distribution.`,
        ...(Platform.OS === 'android' && { channelId: CHANNELS.execution }),
      },
      trigger: null,
    });
  }

  static async sendExecutionStarted(): Promise<void> {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Estate Plan Executing',
        body: 'Estate plan execution has begun. Assets are being distributed to beneficiaries.',
        ...(Platform.OS === 'android' && { channelId: CHANNELS.execution }),
      },
      trigger: null,
    });
  }

  // --- Heartbeat Confirmation ---

  static async sendHeartbeatConfirmed(nextDueDate: Date): Promise<void> {
    const formatted = nextDueDate.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Heartbeat Confirmed',
        body: `Vault is secure. Next heartbeat due: ${formatted}`,
        ...(Platform.OS === 'android' && { channelId: CHANNELS.heartbeat }),
      },
      trigger: null,
    });
  }

  // --- Execution Progress ---

  static async sendDistributionProgress(
    stepNum: number,
    totalSteps: number,
    description: string,
  ): Promise<void> {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: `Distributing... (${stepNum}/${totalSteps})`,
        body: description,
        ...(Platform.OS === 'android' && { channelId: CHANNELS.execution }),
      },
      trigger: null,
    });
  }

  static async sendExecutionComplete(
    transferCount: number,
    totalSolDisplay: string,
  ): Promise<void> {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Estate Plan Complete',
        body: `${transferCount} transfer${transferCount !== 1 ? 's' : ''} completed. ${totalSolDisplay} SOL distributed to beneficiaries.`,
        ...(Platform.OS === 'android' && { channelId: CHANNELS.execution }),
      },
      trigger: null,
    });
  }

  static async sendExecutionFailed(stepDescription: string): Promise<void> {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Execution Paused',
        body: `Distribution halted at: ${stepDescription}. Agent key preserved for recovery.`,
        ...(Platform.OS === 'android' && { channelId: CHANNELS.execution }),
      },
      trigger: null,
    });
  }

  // --- Scheduled (Background) Notifications ---

  static async scheduleNotification(
    title: string,
    body: string,
    channelId: string,
    delaySeconds: number,
    identifier: string,
  ): Promise<void> {
    await Notifications.cancelScheduledNotificationAsync(identifier).catch(() => {});
    await Notifications.scheduleNotificationAsync({
      identifier,
      content: {
        title,
        body,
        ...(Platform.OS === 'android' && { channelId }),
      },
      trigger: {
        type: SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds: Math.max(1, Math.round(delaySeconds)),
        repeats: false,
      },
    });
  }

  static async cancelScheduled(identifier: string): Promise<void> {
    await Notifications.cancelScheduledNotificationAsync(identifier).catch(() => {});
  }

  // --- Escalation Timeline (pre-scheduled, survives app kill) ---

  // Identifier prefix + bound for the pre-scheduled escalation timeline. The
  // whole future escalation sequence is materialized to the OS up-front so the
  // user is warned even if the app is never reopened. Bounded to stay within
  // Android's scheduled-alarm limits.
  static readonly ESCALATION_PREFIX = 'esc-';
  static readonly MAX_ESCALATION_NOTIFS = 50;

  /** Cancel every previously pre-scheduled escalation notification. */
  static async cancelEscalationTimeline(): Promise<void> {
    const cancels: Promise<unknown>[] = [];
    for (let i = 0; i < NotificationService.MAX_ESCALATION_NOTIFS; i++) {
      cancels.push(
        Notifications.cancelScheduledNotificationAsync(
          `${NotificationService.ESCALATION_PREFIX}${i}`,
        ).catch(() => {}),
      );
    }
    await Promise.all(cancels);
  }

  /**
   * Replace the pre-scheduled escalation timeline with a fresh one. Each event
   * is an OS-level TIME_INTERVAL notification, so the sequence fires on schedule
   * even when the app is backgrounded or killed.
   */
  static async scheduleEscalationTimeline(
    events: Array<{ title: string; body: string; channelId: string; delaySeconds: number }>,
  ): Promise<void> {
    await NotificationService.cancelEscalationTimeline();

    const bounded = events.slice(0, NotificationService.MAX_ESCALATION_NOTIFS);
    await Promise.all(
      bounded.map((e, i) =>
        Notifications.scheduleNotificationAsync({
          identifier: `${NotificationService.ESCALATION_PREFIX}${i}`,
          content: {
            title: e.title,
            body: e.body,
            ...(Platform.OS === 'android' && { channelId: e.channelId }),
          },
          trigger: {
            type: SchedulableTriggerInputTypes.TIME_INTERVAL,
            seconds: Math.max(1, Math.round(e.delaySeconds)),
            repeats: false,
          },
        }).catch(() => {}),
      ),
    );
  }

  // --- Cancel All ---

  static async cancelAll(): Promise<void> {
    await Notifications.cancelAllScheduledNotificationsAsync();
    await Notifications.dismissAllNotificationsAsync();
  }
}
