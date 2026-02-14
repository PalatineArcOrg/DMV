import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

const CHANNELS = {
  heartbeat: 'heartbeat',
  escalation: 'escalation',
  execution: 'execution',
} as const;

export class NotificationService {
  private static initialized = false;

  static async initialize(): Promise<void> {
    if (NotificationService.initialized) return;

    const { status } = await Notifications.requestPermissionsAsync();
    if (status !== 'granted') {
      console.warn('Notification permissions not granted');
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

  static async sendHeartbeatReminder(): Promise<void> {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Heartbeat Due',
        body: 'Confirm your Dead Man\'s Vault heartbeat to keep vault active.',
        ...(Platform.OS === 'android' && { channelId: CHANNELS.heartbeat }),
      },
      trigger: null,
    });
  }

  static async sendUrgentReminder(secondsOverdue: number): Promise<void> {
    const hoursOverdue = Math.floor(secondsOverdue / 3600);
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Heartbeat Overdue',
        body: `Your heartbeat is ${hoursOverdue}h overdue. Emergency contacts notified. Tap to confirm.`,
        ...(Platform.OS === 'android' && { channelId: CHANNELS.escalation }),
      },
      trigger: null,
    });
  }

  static async sendEmergencyAlert(): Promise<void> {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Emergency Alert Sent',
        body: 'Emergency contacts notified on-chain. Confirm heartbeat to cancel.',
        ...(Platform.OS === 'android' && { channelId: CHANNELS.escalation }),
      },
      trigger: null,
    });
  }

  static async sendFinalWarning(secondsRemaining: number): Promise<void> {
    const hoursRemaining = Math.max(1, Math.floor(secondsRemaining / 3600));
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'FINAL WARNING',
        body: `Estate plan executes in ${hoursRemaining}h. Confirm NOW to cancel.`,
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

  static async cancelAll(): Promise<void> {
    await Notifications.cancelAllScheduledNotificationsAsync();
    await Notifications.dismissAllNotificationsAsync();
  }
}
