// WP6 — notification token lifecycle.
//
// This module performs LOCAL-ONLY observation of the device push token and derives
// a stable lifecycle state for the Settings UI. It NEVER signs and NEVER mutates
// server state: it does not call `signMessage`, `attemptSignedRegistration`,
// `attemptSignedDeregistration`, `/register`, `/deregister`, or any legacy method.
// Every server mutation is a DELIBERATE user action handled by
// NotificationRegistrationService and triggered only from Settings.
//
// It is dependency-injected and imports ONLY packages, so it unit-tests under
// `node --test` with mocks. No `console.*`. The confirmed-record key builder is
// INJECTED (matching the coordinator's `successKey`) so this module needs no
// source→source import.

/** Namespacing parts for a registration identity (mirrors the coordinator's KeyParts). */
export interface KeyParts {
  cluster: string;
  programId: string;
  owner: string;
  vault: string;
}

// 128-bit token fingerprint: the first 32 lowercase hex chars of SHA-256(token).
// The plaintext token is NEVER stored — only this one-way fingerprint.
export const TOKEN_FP_HEX = 32;
const STRONG_FP = /^[0-9a-f]{32}$/;
const LEGACY_FP = /^[0-9a-f]{16}$/;

export function tokenFingerprint(sha256HexLower: string): string {
  return sha256HexLower.slice(0, TOKEN_FP_HEX);
}
/** A pre-WP6 (WP5) 16-char fingerprint — treated as needing a signed refresh. */
export function isLegacyFingerprint(fp: unknown): boolean {
  return typeof fp === 'string' && LEGACY_FP.test(fp);
}
function isStrongFingerprint(fp: unknown): fp is string {
  return typeof fp === 'string' && STRONG_FP.test(fp);
}

export type LifecycleState =
  | 'not_enabled'
  | 'enabled'
  | 'update_required'
  | 'checking'
  | 'updating'
  | 'disabling'
  | 'disabled'
  | 'token_unavailable'
  | 'owner_mismatch'
  | 'local_cleanup_pending'
  | 'error';

/** The confirmed local record (WP5 SuccessRecord, plus WP6 tombstone fields we read). */
export interface ConfirmedRecord {
  owner: string;
  vault: string;
  revision?: number;
  tokenFingerprint?: string;
  cluster: string;
  programId: string;
  deregisteredAt?: number;
  localCleanupPending?: boolean;
}

/** Local-only marker persisted when a token change is detected (no token, no secrets). */
export interface PendingMarker {
  schemaVersion: number;
  fingerprint: string; // the newly-observed 128-bit fingerprint
  detectedAt: number;
  sequence: number; // monotonic so the newest observation wins
  rotationRequired: true;
}

/** Pending-rotation marker key (separate from the confirmed record). */
export function pendingKey(k: KeyParts): string {
  return `notif_pending/${k.cluster}/${k.programId}/${k.owner}/${k.vault}`;
}

// ── Pure reconciliation ──────────────────────────────────────────────────────
export interface ReconcileInput {
  record: ConfirmedRecord | null; // parsed confirmed record, or null
  currentTokenHashHex: string | null; // sha256(token) lowercase hex, or null if unavailable
  connectedOwner: string;
}

/**
 * Pure local reconciliation. Never signs, never mutates. Fails closed on a corrupt
 * confirmed fingerprint. An older 16-char fingerprint yields `update_required`
 * (a deliberate signed refresh is required to establish the stronger fingerprint —
 * never silently "confirmed" and never silently "disabled").
 */
export function reconcile(inp: ReconcileInput): { state: LifecycleState; fingerprint?: string } {
  const { record, currentTokenHashHex, connectedOwner } = inp;
  if (!record) return { state: 'not_enabled' };
  if (record.owner !== connectedOwner) return { state: 'owner_mismatch' };
  if (record.deregisteredAt) return { state: 'disabled' };
  if (currentTokenHashHex == null) return { state: 'token_unavailable' };
  const fp = tokenFingerprint(currentTokenHashHex);
  const confirmed = record.tokenFingerprint;
  if (isLegacyFingerprint(confirmed)) return { state: 'update_required', fingerprint: fp };
  if (!isStrongFingerprint(confirmed)) return { state: 'error' }; // corrupt confirmed fingerprint
  if (confirmed === fp) return { state: 'enabled', fingerprint: fp };
  return { state: 'update_required', fingerprint: fp };
}

// ── Local-only token observer ────────────────────────────────────────────────
export interface ObserverDeps {
  cluster: string;
  programId: string;
  getConnectedOwner: () => string | null;
  deriveVault: (owner: string) => string;
  getCurrentToken: () => Promise<string | null>;
  sha256Hex: (t: string) => Promise<string>;
  getSetting: (k: string) => Promise<string | null>;
  setSetting: (k: string, v: string) => Promise<void>;
  successKeyFor: (k: KeyParts) => string; // injected (== coordinator's successKey)
  subscribe?: (cb: () => void) => () => void; // token-change source; returns an unsubscribe
  nowMs: () => number;
  onState?: (s: LifecycleState) => void;
}

/**
 * A dependency-injected observer that computes the lifecycle state on demand
 * (Settings focus / app foreground) and on an injected token-change event. It
 * persists ONLY a local pending-rotation marker on a detected mismatch. It never
 * signs and never issues a `/register` or `/deregister` request. A generation
 * counter ensures a stale async completion can neither emit nor overwrite the
 * result of a newer check.
 */
export function makeTokenObserver(deps: ObserverDeps) {
  let generation = 0;
  let disposed = false;
  let unsub: (() => void) | null = null;

  function emit(gen: number, s: LifecycleState) {
    if (gen !== generation || disposed) return; // stale — do not emit
    try {
      deps.onState?.(s);
    } catch {
      /* an observer callback must never break detection */
    }
  }

  async function persistPending(gen: number, key: KeyParts, fingerprint: string) {
    const k = pendingKey(key);
    let prev: PendingMarker | null = null;
    try {
      const raw = await deps.getSetting(k);
      prev = raw ? (JSON.parse(raw) as PendingMarker) : null;
    } catch {
      prev = null;
    }
    if (prev && prev.fingerprint === fingerprint) return; // idempotent: same fp → no write, no growth
    if (gen !== generation || disposed) return; // stale — do not overwrite a newer observation
    const marker: PendingMarker = {
      schemaVersion: 1,
      fingerprint,
      detectedAt: deps.nowMs(),
      sequence: (prev?.sequence ?? 0) + 1, // newest observation wins
      rotationRequired: true,
    };
    await deps.setSetting(k, JSON.stringify(marker));
  }

  async function checkNow(): Promise<LifecycleState> {
    const gen = ++generation;
    const owner = deps.getConnectedOwner();
    if (!owner) {
      emit(gen, 'not_enabled');
      return 'not_enabled';
    }
    let vault: string;
    try {
      vault = deps.deriveVault(owner);
    } catch {
      emit(gen, 'error');
      return 'error';
    }
    const key: KeyParts = { cluster: deps.cluster, programId: deps.programId, owner, vault };
    let record: ConfirmedRecord | null = null;
    try {
      const raw = await deps.getSetting(deps.successKeyFor(key));
      record = raw ? (JSON.parse(raw) as ConfirmedRecord) : null;
    } catch {
      emit(gen, 'error'); // unreadable/corrupt confirmed record → fail closed
      return 'error';
    }
    let hash: string | null = null;
    try {
      const token = await deps.getCurrentToken();
      hash = token ? (await deps.sha256Hex(token)).toLowerCase() : null;
    } catch {
      hash = null; // token acquisition failure → token_unavailable, record preserved
    }
    const { state, fingerprint } = reconcile({ record, currentTokenHashHex: hash, connectedOwner: owner });
    if (state === 'update_required' && fingerprint) {
      try {
        await persistPending(gen, key, fingerprint);
      } catch {
        /* best-effort local persistence; never blocks the app */
      }
    }
    emit(gen, state);
    return state;
  }

  // Bump the generation so any in-flight (stale) check can neither emit nor persist.
  // A deliberate action calls this so a slow observer check started before/during the
  // action (e.g. a token-listener check racing a multi-second wallet approval) cannot
  // stomp the action's terminal state afterwards.
  function invalidate() {
    generation++;
  }

  function start() {
    if (deps.subscribe && !unsub) {
      unsub = deps.subscribe(() => {
        void checkNow();
      });
    }
  }
  function dispose() {
    disposed = true;
    if (unsub) {
      try {
        unsub();
      } catch {
        /* unsubscribe must never throw upward */
      }
      unsub = null;
    }
  }

  return { checkNow, start, dispose, invalidate };
}

// ── Identity-scoped operation lock (WP6 §16) ─────────────────────────────────
export type LifecycleOp = 'register' | 'update' | 'deregister';
interface ActiveOp {
  op: LifecycleOp;
  generation: number;
}
const activeOps = new Map<string, ActiveOp>();
let opGeneration = 0;

export function operationIdentity(k: KeyParts): string {
  return `${k.cluster}/${k.programId}/${k.owner}/${k.vault}`;
}

export type ExclusiveResult<T> =
  | { ran: true; generation: number; value: T }
  | { ran: false; reason: 'noop' | 'conflict'; activeOp: LifecycleOp };

/**
 * Run `fn` under an identity-scoped lock permitting only ONE of register/update/
 * deregister per identity at a time. A repeated identical action is a no-op; a
 * different action while one is active is a conflict (register and deregister can
 * never race). Releases in `finally`, and only if still the current holder, so a
 * stale completion cannot clear a newer holder. Unrelated identities never block.
 */
export async function runExclusive<T>(identity: string, op: LifecycleOp, fn: () => Promise<T>): Promise<ExclusiveResult<T>> {
  const cur = activeOps.get(identity);
  if (cur) {
    return { ran: false, reason: cur.op === op ? 'noop' : 'conflict', activeOp: cur.op };
  }
  const generation = ++opGeneration;
  activeOps.set(identity, { op, generation });
  try {
    const value = await fn();
    return { ran: true, generation, value };
  } finally {
    const now = activeOps.get(identity);
    if (now && now.generation === generation) activeOps.delete(identity);
  }
}

/** True while the given identity has any lifecycle operation in flight. */
export function isOperationActive(identity: string): boolean {
  return activeOps.has(identity);
}
