import {
  Keypair,
  PublicKey,
  type Transaction,
} from '@solana/web3.js';
import bs58 from 'bs58';

export type AgentKeySlot = 'active' | 'candidate' | 'previous';

export type StoredAgentResolution =
  | {
      status: 'active_match' | 'candidate_match' | 'previous_match';
      slot: AgentKeySlot;
      keypair: Keypair;
    }
  | { status: 'no_match' }
  | { status: 'corrupt_slot'; slot: AgentKeySlot }
  | { status: 'multiple_matches'; slots: Array<AgentKeySlot> };

export interface AgentKeySlotStorage {
  get: (key: string, authenticated: boolean) => Promise<string | null>;
  set: (
    key: string,
    value: string,
    authenticated: boolean,
  ) => Promise<boolean>;
  remove: (key: string) => Promise<void>;
}

export interface AgentKeySlotManager {
  generateActive: () => Promise<string>;
  generateCandidate: () => Promise<string>;
  getPublicKey: (slot: AgentKeySlot) => Promise<string | null>;
  hasCompleteSlot: (slot: AgentKeySlot) => Promise<boolean>;
  /**
   * Metadata-only presence check. Reads the slot's public key and flags, which
   * are stored WITHOUT `requireAuthentication`, and never touches the secret — so
   * it raises no biometric prompt and works from a cold start before any Activity
   * is resumed. Answers "is a key stored here?", not "can I use it right now?".
   */
  hasStoredSlot: (slot: AgentKeySlot) => Promise<boolean>;
  /** Metadata-only public key. Same no-prompt guarantee as `hasStoredSlot`. */
  getStoredPublicKey: (slot: AgentKeySlot) => Promise<string | null>;
  loadSlot: (slot: AgentKeySlot) => Promise<Keypair>;
  loadByExactPublicKey: (publicKey: string) => Promise<Keypair>;
  resolveForOnChainPublicKey: (
    publicKey: string,
  ) => Promise<StoredAgentResolution>;
  promoteCandidate: (
    oldAgent: string,
    candidateAgent: string,
  ) => Promise<void>;
  removeSlot: (slot: AgentKeySlot) => Promise<void>;
  signWithSlot: (
    slot: AgentKeySlot,
    transaction: Transaction,
  ) => Promise<Transaction>;
}

interface SlotNames {
  secret: string;
  publicKey: string;
  auth: string;
  complete: string;
}

const SLOT_NAMES: Record<AgentKeySlot, SlotNames> = {
  active: {
    // Keep the original names so existing installations retain their key.
    secret: 'dmv_agent_secret_key',
    publicKey: 'dmv_agent_public_key',
    auth: 'dmv_agent_key_auth',
    complete: 'dmv_agent_key_complete',
  },
  candidate: {
    secret: 'dmv_agent_candidate_secret_key',
    publicKey: 'dmv_agent_candidate_public_key',
    auth: 'dmv_agent_candidate_key_auth',
    complete: 'dmv_agent_candidate_key_complete',
  },
  previous: {
    secret: 'dmv_agent_previous_secret_key',
    publicKey: 'dmv_agent_previous_public_key',
    auth: 'dmv_agent_previous_key_auth',
    complete: 'dmv_agent_previous_key_complete',
  },
};

interface LoadedSlot {
  keypair: Keypair;
  publicKey: string;
  authenticated: boolean;
}

class MissingSlotError extends Error {
  constructor(slot: AgentKeySlot) {
    super(`No complete ${slot} agent key is stored`);
    this.name = 'MissingSlotError';
  }
}

class CorruptSlotError extends Error {
  readonly slot: AgentKeySlot;

  constructor(slot: AgentKeySlot) {
    super(`Stored ${slot} agent key is incomplete or invalid`);
    this.name = 'CorruptSlotError';
    this.slot = slot;
  }
}

function isCanonicalPublicKey(value: string): boolean {
  try {
    return (
      value.length <= 64 &&
      new PublicKey(value).toBase58() === value
    );
  } catch {
    return false;
  }
}

interface SlotMetadata {
  publicKey: string | null;
  auth: string | null;
  complete: string | null;
}

/**
 * True iff the slot's unauthenticated metadata describes a stored key — the same
 * shape rule `readSlot` applies, including the legacy-active allowance for a
 * pre-Phase-4 slot with no completion marker, but without reading the secret.
 *
 * A `true` here means "a key is stored"; it does not promise the secret is
 * readable right now (that needs authentication and a resumed Activity).
 */
function isStoredSlotShape(
  slot: AgentKeySlot,
  metadata: SlotMetadata,
): boolean {
  if (metadata.publicKey === null) return false;
  if (!isCanonicalPublicKey(metadata.publicKey)) return false;
  const isLegacyActive =
    slot === 'active' &&
    metadata.complete === null &&
    (metadata.auth === null ||
      metadata.auth === '0' ||
      metadata.auth === '1');
  if (metadata.auth !== '0' && metadata.auth !== '1' && !isLegacyActive) {
    return false;
  }
  if (metadata.complete !== '1' && !isLegacyActive) return false;
  return true;
}

function wipe(keypair: Keypair | undefined): void {
  if (!keypair) return;
  keypair.secretKey.fill(0);
  const internal = Reflect.get(keypair, '_keypair');
  if (internal && typeof internal === 'object') {
    const internalSecret = Reflect.get(internal, 'secretKey');
    if (internalSecret instanceof Uint8Array) {
      internalSecret.fill(0);
    }
  }
}

export function createAgentKeySlotManager(
  storage: AgentKeySlotStorage,
  generateKeypair: () => Keypair = () => Keypair.generate(),
): AgentKeySlotManager {
  const cache = new Map<AgentKeySlot, Keypair>();

  async function readMetadata(
    slot: AgentKeySlot,
  ): Promise<{
    publicKey: string | null;
    auth: string | null;
    complete: string | null;
  }> {
    const names = SLOT_NAMES[slot];
    const [publicKey, auth, complete] = await Promise.all([
      storage.get(names.publicKey, false),
      storage.get(names.auth, false),
      storage.get(names.complete, false),
    ]);
    return { publicKey, auth, complete };
  }

  async function readSlot(slot: AgentKeySlot): Promise<LoadedSlot> {
    const cached = cache.get(slot);
    const metadata = await readMetadata(slot);
    const isLegacyActive =
      slot === 'active' &&
      metadata.publicKey !== null &&
      metadata.complete === null &&
      (metadata.auth === null ||
        metadata.auth === '0' ||
        metadata.auth === '1');
    if (
      metadata.publicKey === null &&
      metadata.auth === null &&
      metadata.complete === null
    ) {
      throw new MissingSlotError(slot);
    }
    if (
      metadata.publicKey === null ||
      (
        metadata.auth !== '0' &&
        metadata.auth !== '1' &&
        !isLegacyActive
      ) ||
      (metadata.complete !== '1' && !isLegacyActive)
    ) {
      throw new CorruptSlotError(slot);
    }
    if (cached) {
      if (cached.publicKey.toBase58() !== metadata.publicKey) {
        wipe(cached);
        cache.delete(slot);
        throw new CorruptSlotError(slot);
      }
      return {
        keypair: cached,
        publicKey: metadata.publicKey,
        authenticated: metadata.auth === '1',
      };
    }

    const secret = await storage.get(
      SLOT_NAMES[slot].secret,
      metadata.auth === '1',
    );
    if (!secret) throw new CorruptSlotError(slot);
    let keypair: Keypair;
    try {
      keypair = Keypair.fromSecretKey(bs58.decode(secret));
    } catch {
      throw new CorruptSlotError(slot);
    }
    if (
      !isCanonicalPublicKey(metadata.publicKey) ||
      keypair.publicKey.toBase58() !== metadata.publicKey
    ) {
      wipe(keypair);
      throw new CorruptSlotError(slot);
    }
    cache.set(slot, keypair);
    return {
      keypair,
      publicKey: metadata.publicKey,
      authenticated: metadata.auth === '1',
    };
  }

  async function writeSlot(
    slot: AgentKeySlot,
    keypair: Keypair,
    authenticated: boolean,
  ): Promise<void> {
    const names = SLOT_NAMES[slot];
    const publicKey = keypair.publicKey.toBase58();
    const actualAuthenticated = await storage.set(
      names.secret,
      bs58.encode(keypair.secretKey),
      authenticated,
    );
    await storage.set(names.publicKey, publicKey, false);
    await storage.set(
      names.auth,
      actualAuthenticated ? '1' : '0',
      false,
    );
    await storage.set(names.complete, '1', false);

    const oldCached = cache.get(slot);
    if (oldCached && oldCached !== keypair) wipe(oldCached);
    cache.set(slot, keypair);
    const readBack = await readSlot(slot);
    if (readBack.publicKey !== publicKey) {
      throw new CorruptSlotError(slot);
    }
  }

  async function removeSlot(slot: AgentKeySlot): Promise<void> {
    const cached = cache.get(slot);
    wipe(cached);
    cache.delete(slot);
    const names = SLOT_NAMES[slot];
    await storage.remove(names.secret);
    await storage.remove(names.publicKey);
    await storage.remove(names.auth);
    await storage.remove(names.complete);
  }

  async function resolveForOnChainPublicKey(
    publicKey: string,
  ): Promise<StoredAgentResolution> {
    const matches: Array<{
      slot: AgentKeySlot;
      keypair: Keypair;
    }> = [];
    for (const slot of [
      'active',
      'candidate',
      'previous',
    ] as const) {
      try {
        const loaded = await readSlot(slot);
        if (loaded.publicKey === publicKey) {
          matches.push({ slot, keypair: loaded.keypair });
        }
      } catch (error: unknown) {
        if (error instanceof MissingSlotError) continue;
        return { status: 'corrupt_slot', slot };
      }
    }
    if (matches.length === 0) return { status: 'no_match' };
    if (matches.length > 1) {
      return {
        status: 'multiple_matches',
        slots: matches.map((match) => match.slot),
      };
    }
    const match = matches[0];
    return {
      status: `${match.slot}_match`,
      slot: match.slot,
      keypair: match.keypair,
    };
  }

  return {
    generateActive: async () => {
      const existing = await readMetadata('active');
      if (
        existing.publicKey !== null ||
        existing.auth !== null ||
        existing.complete !== null
      ) {
        throw new Error('An active agent slot already exists');
      }
      const keypair = generateKeypair();
      try {
        await writeSlot('active', keypair, true);
        return keypair.publicKey.toBase58();
      } catch (error: unknown) {
        wipe(keypair);
        cache.delete('active');
        throw error;
      }
    },
    generateCandidate: async () => {
      const existing = await readMetadata('candidate');
      if (
        existing.publicKey !== null ||
        existing.auth !== null ||
        existing.complete !== null
      ) {
        throw new Error(
          'A candidate agent slot already exists and must be resolved explicitly',
        );
      }
      const keypair = generateKeypair();
      try {
        await writeSlot('candidate', keypair, true);
        return keypair.publicKey.toBase58();
      } catch (error: unknown) {
        wipe(keypair);
        cache.delete('candidate');
        throw error;
      }
    },
    getPublicKey: async (slot) => {
      try {
        return (await readSlot(slot)).publicKey;
      } catch (error: unknown) {
        if (error instanceof MissingSlotError) return null;
        throw error;
      }
    },
    hasCompleteSlot: async (slot) => {
      try {
        await readSlot(slot);
        return true;
      } catch {
        return false;
      }
    },
    // Metadata-only. Deliberately does NOT call readSlot(): that loads the secret
    // under `requireAuthentication` when auth === '1', which raises a biometric
    // prompt and fails outright at cold start with no resumed Activity. Callers
    // asking "is a key stored?" must not be answered "no" merely because the
    // device could not prompt at that instant.
    hasStoredSlot: async (slot) => {
      const metadata = await readMetadata(slot);
      return isStoredSlotShape(slot, metadata);
    },
    getStoredPublicKey: async (slot) => {
      const metadata = await readMetadata(slot);
      return isStoredSlotShape(slot, metadata) ? metadata.publicKey : null;
    },
    loadSlot: async (slot) => (await readSlot(slot)).keypair,
    loadByExactPublicKey: async (publicKey) => {
      const resolution = await resolveForOnChainPublicKey(publicKey);
      if (
        resolution.status === 'active_match' ||
        resolution.status === 'candidate_match' ||
        resolution.status === 'previous_match'
      ) {
        return resolution.keypair;
      }
      throw new Error(
        'No single usable stored agent key matches the requested public key',
      );
    },
    resolveForOnChainPublicKey,
    promoteCandidate: async (oldAgent, candidateAgent) => {
      const active = await readSlot('active');
      const candidateMetadata = await readMetadata('candidate');

      // Idempotent crash recovery: active already contains the candidate.
      if (active.publicKey === candidateAgent) {
        const previous = await readSlot('previous');
        if (previous.publicKey !== oldAgent) {
          throw new Error(
            'Candidate promotion is incomplete and previous key does not match',
          );
        }
        if (candidateMetadata.publicKey === candidateAgent) {
          await removeSlot('candidate');
        } else if (candidateMetadata.publicKey !== null) {
          throw new CorruptSlotError('candidate');
        }
        return;
      }
      if (active.publicKey !== oldAgent) {
        throw new Error('Active slot no longer matches the pre-rotation agent');
      }
      const candidate = await readSlot('candidate');
      if (candidate.publicKey !== candidateAgent) {
        throw new Error('Candidate slot does not match the on-chain candidate');
      }

      // Copy-before-remove ordering makes every crash point recoverable.
      const previousMetadata = await readMetadata('previous');
      const hasPreviousMetadata =
        previousMetadata.publicKey !== null ||
        previousMetadata.auth !== null ||
        previousMetadata.complete !== null;
      if (hasPreviousMetadata) {
        const previous = await readSlot('previous');
        if (previous.publicKey !== oldAgent) {
          throw new Error(
            'A different previous key is retained and requires explicit cleanup',
          );
        }
      } else {
        await writeSlot(
          'previous',
          Keypair.fromSecretKey(active.keypair.secretKey),
          active.authenticated,
        );
      }
      await writeSlot(
        'active',
        Keypair.fromSecretKey(candidate.keypair.secretKey),
        candidate.authenticated,
      );
      const promoted = await readSlot('active');
      const retained = await readSlot('previous');
      if (
        promoted.publicKey !== candidateAgent ||
        retained.publicKey !== oldAgent
      ) {
        throw new Error('Agent key promotion read-back validation failed');
      }
      await removeSlot('candidate');
    },
    removeSlot,
    signWithSlot: async (slot, transaction) => {
      const keypair = (await readSlot(slot)).keypair;
      transaction.partialSign(keypair);
      return transaction;
    },
  };
}

export { CorruptSlotError, MissingSlotError };
