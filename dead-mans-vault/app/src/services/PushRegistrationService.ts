import * as Notifications from 'expo-notifications';
import * as Crypto from 'expo-crypto';
import bs58 from 'bs58';
import { Buffer } from 'buffer';
import { NOTIFY_URL, NOTIFY_SECRET } from '../utils/constants';
import { registerMessage, deregisterMessage } from '../utils/notifyAuth';
import { getSetting, setSetting } from '../db/settingsRepo';

/** Signs a raw message with the owner wallet (MWA `signMessage`). */
export type SignMessage = (message: Uint8Array) => Promise<Uint8Array>;

const REG_FINGERPRINT_KEY = 'notify_reg_fingerprint';

/**
 * Registers this device with the DMV notify server so escalation pushes reach
 * the owner even when the app is killed. Registration is now **owner-signed**:
 * the server rejects any request that isn't signed by the vault's owner wallet,
 * so a leaked app secret can no longer rebind or silence another owner's vault.
 *
 * All methods fail soft: if the notify server / push / wallet signing isn't
 * available they no-op (they do NOT silently register unsigned).
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

  private static sha256Hex(text: string): Promise<string> {
    return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text);
  }

  /**
   * Register (owner-signed). Returns true if the server accepted (or if we were
   * already registered for this exact owner/vault/token/stages — the fingerprint
   * skip avoids prompting the wallet on every app open). Requires `signMessage`;
   * with none provided we do NOT register (the server would reject it anyway).
   */
  static async register(
    owner: string,
    vault: string,
    stages: { stage1: number; stage2: number; stage3: number },
    signMessage?: SignMessage,
  ): Promise<boolean> {
    if (!NOTIFY_URL) return false;
    if (!signMessage) return false; // never register without an owner signature
    try {
      const deviceToken = await PushRegistrationService.getDeviceToken();
      if (!deviceToken) return false;

      // Skip (and don't prompt the wallet) if nothing changed since last register.
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

  /**
   * Deregister (owner-signed) a vault's push registration. Requires `signMessage`.
   * NB: the revoke flow does NOT call this — closing the vault on-chain makes the
   * server auto-drop the registration — so this is for an explicit "stop
   * notifications while keeping the vault" action.
   */
  static async deregister(owner: string, vault: string, signMessage?: SignMessage): Promise<void> {
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
