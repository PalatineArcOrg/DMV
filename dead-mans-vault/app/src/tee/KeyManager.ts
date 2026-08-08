import { Keypair, Transaction } from '@solana/web3.js';
import * as SecureStore from 'expo-secure-store';
import {
  createAgentKeySlotManager,
  type AgentKeySlot,
  type StoredAgentResolution,
} from './AgentKeySlotManagerCore';

const AUTH_PROMPT = 'Authenticate to use your Dead Man’s Vault agent key';

// Device-only, unauthenticated storage options reused for the public key + flag.
const BASE_OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export class KeyManager {
  private static instance: KeyManager | null = null;
  private readonly slots = createAgentKeySlotManager({
    get: (key, authenticated) =>
      SecureStore.getItemAsync(
        key,
        authenticated
          ? {
              requireAuthentication: true,
              authenticationPrompt: AUTH_PROMPT,
            }
          : undefined,
      ),
    set: async (key, value, authenticated) => {
      if (authenticated) {
        try {
          await SecureStore.setItemAsync(key, value, {
            ...BASE_OPTS,
            requireAuthentication: true,
            authenticationPrompt: AUTH_PROMPT,
          });
          return true;
        } catch {
          // Preserve legacy availability on devices without an enrolled lock
          // screen. Authentication mode is recorded per slot by the core.
        }
      }
      await SecureStore.setItemAsync(key, value, BASE_OPTS);
      return false;
    },
    remove: (key) => SecureStore.deleteItemAsync(key),
  });

  static getInstance(): KeyManager {
    if (!KeyManager.instance) {
      KeyManager.instance = new KeyManager();
    }
    return KeyManager.instance;
  }

  async generateAgentKey(): Promise<string> {
    // Initial vault setup is allowed only when no active slot exists. Candidate
    // generation for rotation uses generateCandidateAgentKey() and never calls
    // this method.
    return this.slots.generateActive();
  }

  /**
   * Metadata-only: no biometric prompt. Startup callers ask this to decide whether
   * a key exists, and must not be told "no" because the device could not prompt.
   */
  async getAgentPublicKey(): Promise<string | null> {
    return this.slots.getStoredPublicKey('active');
  }

  /** Metadata-only presence check; raises no biometric prompt. See getAgentPublicKey. */
  async hasAgentKey(): Promise<boolean> {
    return this.slots.hasStoredSlot('active');
  }

  async getKeypair(): Promise<Keypair> {
    return this.slots.loadSlot('active');
  }

  async signTransaction(tx: Transaction): Promise<Transaction> {
    const keypair = await this.getKeypair();
    tx.partialSign(keypair);
    return tx;
  }

  async destroyKey(): Promise<void> {
    // Explicit vault teardown only. Rotation code must never call this method.
    await this.slots.removeSlot('active');
  }

  async generateCandidateAgentKey(): Promise<string> {
    return this.slots.generateCandidate();
  }

  async getCandidatePublicKey(): Promise<string | null> {
    return this.slots.getPublicKey('candidate');
  }

  async getPreviousAgentPublicKey(): Promise<string | null> {
    return this.slots.getPublicKey('previous');
  }

  async loadCandidateKeypair(): Promise<Keypair> {
    return this.slots.loadSlot('candidate');
  }

  async loadKeypairByExactPublicKey(publicKey: string): Promise<Keypair> {
    return this.slots.loadByExactPublicKey(publicKey);
  }

  async resolveStoredAgentForOnChainPubkey(
    publicKey: string,
  ): Promise<StoredAgentResolution> {
    return this.slots.resolveForOnChainPublicKey(publicKey);
  }

  async promoteCandidate(
    oldAgent: string,
    candidateAgent: string,
  ): Promise<void> {
    await this.slots.promoteCandidate(oldAgent, candidateAgent);
  }

  async deleteSlot(slot: AgentKeySlot): Promise<void> {
    await this.slots.removeSlot(slot);
  }

}
