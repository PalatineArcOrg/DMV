import { Keypair, Transaction } from '@solana/web3.js';
import * as SecureStore from 'expo-secure-store';
import bs58 from 'bs58';

const SECRET_KEY = 'dmv_agent_secret_key';
const PUBLIC_KEY = 'dmv_agent_public_key';
// '1' when the secret was stored behind a device-credential/biometric gate, so
// getKeypair() reads it back with matching options (mismatched options can fail
// decryption on Android). Absent/'0' for legacy keys stored without the gate.
const AUTH_FLAG = 'dmv_agent_key_auth';

const AUTH_PROMPT = 'Authenticate to use your Dead Man’s Vault agent key';

// Device-only, unauthenticated storage options reused for the public key + flag.
const BASE_OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export class KeyManager {
  private static instance: KeyManager | null = null;
  private cachedKeypair: Keypair | null = null;

  static getInstance(): KeyManager {
    if (!KeyManager.instance) {
      KeyManager.instance = new KeyManager();
    }
    return KeyManager.instance;
  }

  async generateAgentKey(): Promise<string> {
    const keypair = Keypair.generate();
    const secretB58 = bs58.encode(keypair.secretKey);
    const publicB58 = keypair.publicKey.toBase58();

    // Prefer a biometric / device-credential gate on the secret. The agent key
    // signs record_heartbeat (which resets the liveness clock), so gating it
    // stops silently-extracted key material from forging heartbeats and stalling
    // the switch. Fall back to unauthenticated (still device-only) storage if the
    // device has no secure lock screen enrolled, so key generation never hard-fails.
    let authed = true;
    try {
      await SecureStore.setItemAsync(SECRET_KEY, secretB58, {
        ...BASE_OPTS,
        requireAuthentication: true,
        authenticationPrompt: AUTH_PROMPT,
      });
    } catch {
      authed = false;
      await SecureStore.setItemAsync(SECRET_KEY, secretB58, BASE_OPTS);
    }

    await SecureStore.setItemAsync(PUBLIC_KEY, publicB58, BASE_OPTS);
    await SecureStore.setItemAsync(AUTH_FLAG, authed ? '1' : '0', BASE_OPTS);

    this.cachedKeypair = keypair;
    return publicB58;
  }

  async getAgentPublicKey(): Promise<string | null> {
    return SecureStore.getItemAsync(PUBLIC_KEY);
  }

  async hasAgentKey(): Promise<boolean> {
    const pk = await SecureStore.getItemAsync(PUBLIC_KEY);
    return pk !== null;
  }

  async getKeypair(): Promise<Keypair> {
    if (this.cachedKeypair) return this.cachedKeypair;

    // Read back with options matching how it was stored (a legacy key with no
    // flag was stored unauthenticated). This triggers the biometric prompt once
    // per session for gated keys; subsequent calls hit the in-memory cache.
    const authed = (await SecureStore.getItemAsync(AUTH_FLAG)) === '1';
    const secretB58 = await SecureStore.getItemAsync(
      SECRET_KEY,
      authed ? { requireAuthentication: true, authenticationPrompt: AUTH_PROMPT } : undefined,
    );
    if (!secretB58) {
      throw new Error('No agent key found in secure store');
    }

    const secretKey = bs58.decode(secretB58);
    this.cachedKeypair = Keypair.fromSecretKey(secretKey);
    return this.cachedKeypair;
  }

  async signTransaction(tx: Transaction): Promise<Transaction> {
    const keypair = await this.getKeypair();
    tx.partialSign(keypair);
    return tx;
  }

  async destroyKey(): Promise<void> {
    // Wipe the secret bytes from the JS heap before dropping the reference, so a
    // later heap dump can't recover a "destroyed" key.
    if (this.cachedKeypair) {
      this.cachedKeypair.secretKey.fill(0);
    }
    this.cachedKeypair = null;
    await SecureStore.deleteItemAsync(SECRET_KEY);
    await SecureStore.deleteItemAsync(PUBLIC_KEY);
    await SecureStore.deleteItemAsync(AUTH_FLAG);
  }
}
