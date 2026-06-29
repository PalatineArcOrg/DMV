import * as Notifications from 'expo-notifications';
import { NOTIFY_URL, NOTIFY_SECRET } from '../utils/constants';

/**
 * Registers this device with the DMV notify server so escalation pushes reach
 * the owner even when the app is fully closed/killed (which local scheduled
 * notifications cannot do reliably on Android). The server watches the vault's
 * on-chain heartbeat and sends FCM pushes on escalation — so the app only has
 * to register its FCM token + stage durations once; it does NOT need to ping
 * on every heartbeat (the server reads heartbeats from chain).
 *
 * All methods fail soft: if the notify server or FCM isn't configured, they
 * no-op so the rest of the app is unaffected.
 */
export class PushRegistrationService {
  private static headers() {
    return {
      'content-type': 'application/json',
      ...(NOTIFY_SECRET ? { 'x-dmv-secret': NOTIFY_SECRET } : {}),
    };
  }

  /** Native FCM device token (Android). Null if FCM isn't configured in this build. */
  static async getDeviceToken(): Promise<string | null> {
    try {
      const token = await Notifications.getDevicePushTokenAsync();
      return typeof token?.data === 'string' ? token.data : null;
    } catch {
      return null;
    }
  }

  static async register(
    owner: string,
    vault: string,
    stages: { stage1: number; stage2: number; stage3: number },
  ): Promise<boolean> {
    if (!NOTIFY_URL) return false;
    try {
      const deviceToken = await PushRegistrationService.getDeviceToken();
      if (!deviceToken) return false;
      const res = await fetch(`${NOTIFY_URL}/register`, {
        method: 'POST',
        headers: PushRegistrationService.headers(),
        body: JSON.stringify({ owner, vault, deviceToken, ...stages }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  static async deregister(vault: string): Promise<void> {
    if (!NOTIFY_URL) return;
    try {
      await fetch(`${NOTIFY_URL}/deregister`, {
        method: 'POST',
        headers: PushRegistrationService.headers(),
        body: JSON.stringify({ vault }),
      });
    } catch {
      // Non-fatal — server will also auto-drop the registration once it sees
      // the vault is revoked/closed on-chain.
    }
  }
}
