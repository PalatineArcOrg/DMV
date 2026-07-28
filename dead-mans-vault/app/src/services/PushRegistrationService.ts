import * as Notifications from 'expo-notifications';

/**
 * Native FCM device-token access for the notification flows.
 *
 * ── Registration auth (Phase 3, devnet-sealed) ─────────────────────────────
 * Registration with the notify server is DELIBERATE and OWNER-SIGNED only, via
 * `NotificationRegistrationService.attemptSignedRegistration` /
 * `attemptSignedDeregistration`, wired to explicit Settings actions. There is no
 * background, mount, focus, foreground, heartbeat or timer registration path.
 *
 * The historical unsigned ("legacy") register/deregister methods — a plain
 * shared-secret POST (a legacy secret request header) authenticated by a server secret shipped inside the
 * app bundle — have been REMOVED, along with the secret itself. That secret was
 * published in the v1.13.20 release APK and is permanently burned; it has been
 * rotated server-side and must never be reintroduced into a client.
 *
 * The live devnet notify-server is sealed in `signed` mode: legacy register and
 * deregister writes are rejected before any secret, RPC or database work, so no
 * client-side legacy path can succeed. Do not re-add one.
 *
 * This class therefore exposes only the device token. It performs no network I/O.
 */
export class PushRegistrationService {
  /** Native FCM device token (Android). Null if FCM isn't configured in this build. */
  static async getDeviceToken(): Promise<string | null> {
    try {
      const token = await Notifications.getDevicePushTokenAsync();
      return typeof token?.data === 'string' ? token.data : null;
    } catch {
      return null;
    }
  }
}
