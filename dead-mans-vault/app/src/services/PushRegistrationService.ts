import * as Notifications from 'expo-notifications';
import * as Crypto from 'expo-crypto';
import bs58 from 'bs58';
import { Buffer } from 'buffer';
import { NOTIFY_URL, NOTIFY_SECRET } from '../utils/constants';
import { registerMessage, deregisterMessage } from '../utils/notifyAuth';
import { getSetting, setSetting } from '../db/settingsRepo';
import { isNetworkVerified } from '../store/useNetworkStore';

/** Signs a raw message with the owner wallet (MWA `signMessage`). */
export type SignMessage = (message: Uint8Array) => Promise<Uint8Array>;

const REG_FINGERPRINT_KEY = 'notify_reg_fingerprint';

/**
 * Registers this device with the DMV notify server so escalation pushes reach
 * the owner even when the app is fully closed/killed (which local scheduled
 * notifications cannot do reliably on Android). The server watches the vault's
 * on-chain heartbeat and sends FCM pushes on escalation — the app only has to
 * register its FCM token + stage durations once; it does NOT ping on every
 * heartbeat (the server reads heartbeats from chain).
 *
 * All methods fail soft: if the notify server / FCM isn't configured they no-op
 * so the rest of the app is unaffected.
 *
 * ── Registration auth ──────────────────────────────────────────────────────
 * As of WP5 the app registers via a DELIBERATE owner-signed V2 flow
 * (`NotificationRegistrationService.attemptSignedRegistration`, wired from the
 * Settings screen) — NOT this unsigned path. `register`/`deregister` below are
 * the legacy unsigned methods (a plain `x-dmv-secret` POST + server-side on-chain
 * ownership proof); they have NO active call site in the app anymore and are kept
 * only for backwards compatibility / isolated tests. Do not re-wire them.
 *
 * `registerSigned`/`deregisterSigned` are the DORMANT owner-signed variants (an
 * MWA signMessage over a canonical `notifyAuth` message). They exist so mainnet
 * can add "prove you hold the owner key" on top of the ownership proof — but
 * they MUST ship together with the signature-VERIFYING server (see
 * notify-server `registerAuth.js`, currently committed-but-not-deployed).
 * To light them up for mainnet:
 *   1. Deploy the notify-server with signature verification enabled (accept
 *      both signed + unsigned during a transition window, then signed-only).
 *   2. Swap the `useHeartbeat` call from `register(...)` to
 *      `registerSigned(..., signMessage)`, signing at a deliberate wallet
 *      moment (ideally within the vault-activation MWA session — NOT an auto
 *      background popup, which is what made the first attempt unreliable).
 *   3. Device-test the full round-trip (sign → server verify → push on close).
 * Until all three are done, keep the unsigned path active.
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

  /**
   * Register (unsigned — ACTIVE). Silent background POST; returns true if the
   * server accepted. Matches the deployed server (on-chain ownership proof, no
   * signature required). No wallet interaction, so it registers reliably.
   */
  static async register(
    owner: string,
    vault: string,
    stages: { stage1: number; stage2: number; stage3: number },
  ): Promise<boolean> {
    if (!NOTIFY_URL) return false;
    // Fail-closed: don't register a vault with the notify server from an unverified network.
    if (!isNetworkVerified()) return false;
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

  /** Deregister (unsigned — ACTIVE). Rarely needed: closing the vault on-chain
   *  makes the server auto-drop the registration. */
  static async deregister(vault: string): Promise<void> {
    if (!NOTIFY_URL) return;
    try {
      await fetch(`${NOTIFY_URL}/deregister`, {
        method: 'POST',
        headers: PushRegistrationService.headers(),
        body: JSON.stringify({ vault }),
      });
    } catch {
      // Non-fatal — server also auto-drops once the vault is revoked/closed.
    }
  }

  private static sha256Hex(text: string): Promise<string> {
    return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text);
  }

  /**
   * Register (owner-signed — DORMANT; mainnet only, ships with the verifying
   * server). See the class-level note for the activation checklist. Skips
   * re-prompting the wallet when nothing changed since the last register.
   */
  static async registerSigned(
    owner: string,
    vault: string,
    stages: { stage1: number; stage2: number; stage3: number },
    signMessage?: SignMessage,
  ): Promise<boolean> {
    if (!NOTIFY_URL) return false;
    if (!signMessage) return false; // never register signed without an owner signature
    try {
      const deviceToken = await PushRegistrationService.getDeviceToken();
      if (!deviceToken) return false;

      const fingerprint = await PushRegistrationService.sha256Hex(
        `${owner}|${vault}|${deviceToken}|${stages.stage1}|${stages.stage2}|${stages.stage3}`,
      );
      if ((await getSetting(REG_FINGERPRINT_KEY)) === fingerprint) return true;

      const deviceTokenHash = await PushRegistrationService.sha256Hex(deviceToken);
      const timestamp = Math.floor(Date.now() / 1000);
      const nonce = Crypto.randomUUID();
      const message = registerMessage({
        owner,
        vault,
        deviceTokenHash,
        stage1: stages.stage1,
        stage2: stages.stage2,
        stage3: stages.stage3,
        timestamp,
        nonce,
      });
      const signature = bs58.encode(await signMessage(Buffer.from(message, 'utf8')));

      const res = await fetch(`${NOTIFY_URL}/register`, {
        method: 'POST',
        headers: PushRegistrationService.headers(),
        body: JSON.stringify({ owner, vault, deviceToken, ...stages, signature, timestamp, nonce }),
      });
      if (res.ok) {
        await setSetting(REG_FINGERPRINT_KEY, fingerprint);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /** Deregister (owner-signed — DORMANT; mainnet only). */
  static async deregisterSigned(owner: string, vault: string, signMessage?: SignMessage): Promise<void> {
    if (!NOTIFY_URL || !signMessage) return;
    try {
      const timestamp = Math.floor(Date.now() / 1000);
      const nonce = Crypto.randomUUID();
      const message = deregisterMessage({ owner, vault, timestamp, nonce });
      const signature = bs58.encode(await signMessage(Buffer.from(message, 'utf8')));
      await fetch(`${NOTIFY_URL}/deregister`, {
        method: 'POST',
        headers: PushRegistrationService.headers(),
        body: JSON.stringify({ owner, vault, signature, timestamp, nonce }),
      });
      await setSetting(REG_FINGERPRINT_KEY, ''); // force a re-sign on next register
    } catch {
      // Non-fatal.
    }
  }
}
