import type { PublicKey } from '@solana/web3.js';
import type {
  AccountInfoLike,
  RawHeartbeatRecord,
  RawVaultConfig,
} from '../utils/rawAccountParsers';
import type { DeadlineStageDurations } from '../utils/deadlineStageConfig';
import type { EscalationStage } from '../types';

export const DEADLINE_FRESHNESS_WINDOW_MS = 30_000;

export interface ConfirmedChainTime {
  slot: number;
  unixTimestamp: number;
}

export type ConfirmedChainTimeResult =
  | ({ status: 'verified' } & ConfirmedChainTime)
  | { status: 'rpc_unavailable' }
  | { status: 'chain_time_unavailable' }
  | { status: 'chain_time_invalid' };

/**
 * How often to re-read the canonical deadline, and how long a monotonic projection
 * may be trusted between reads.
 *
 * A fixed 30s poll costs ~480 RPC calls/hour for every foregrounded Dashboard,
 * which on a shared key is enough to get the app throttled — while it watches a
 * clock whose next event may be a week away. The cost is paid to answer a question
 * that barely changes.
 *
 * The interval therefore scales with the remaining margin, and the freshness window
 * scales WITH it so the countdown never falls into a spurious `stale` state between
 * reads. Extending the window is safe: a projection is monotonic-clock arithmetic on
 * a verified snapshot, so it stays exact for as long as the clock is monotonic.
 *
 * This CANNOT weaken the execution boundary. `projectAuthoritativeDeadline` returns
 * `stage4_refresh_required` the moment a projection would cross `finalDeadline`, and
 * pins `executableByTime: false` on every projected snapshot, so Stage 4 is only ever
 * entered from a fresh verified read. Both behaviours are independent of the values
 * chosen here — the tests assert that at the widest interval.
 */
export interface DeadlineRefreshPlan {
  intervalMs: number;
  freshnessWindowMs: number;
}

export const DEADLINE_REFRESH_NEAR_MS = 30_000;
export const DEADLINE_REFRESH_MID_MS = 60_000;
export const DEADLINE_REFRESH_FAR_MS = 300_000;

/** Seconds of remaining margin below which we keep the tightest cadence. */
export const DEADLINE_NEAR_SECONDS = 3_600;
/** Seconds of remaining margin above which the widest cadence is used. */
export const DEADLINE_FAR_SECONDS = 86_400;

export function deadlineRefreshPlan(
  secondsUntilFinalDeadline: number | null | undefined,
): DeadlineRefreshPlan {
  // Unknown margin (no verified snapshot yet, or a nonsense value) keeps the
  // tightest cadence. Backing off is an optimisation and must never be the
  // fallback for missing information.
  if (
    typeof secondsUntilFinalDeadline !== 'number' ||
    !Number.isFinite(secondsUntilFinalDeadline) ||
    secondsUntilFinalDeadline < 0
  ) {
    return {
      intervalMs: DEADLINE_REFRESH_NEAR_MS,
      freshnessWindowMs: DEADLINE_FRESHNESS_WINDOW_MS,
    };
  }
  if (secondsUntilFinalDeadline <= DEADLINE_NEAR_SECONDS) {
    return {
      intervalMs: DEADLINE_REFRESH_NEAR_MS,
      freshnessWindowMs: DEADLINE_FRESHNESS_WINDOW_MS,
    };
  }
  if (secondsUntilFinalDeadline <= DEADLINE_FAR_SECONDS) {
    return {
      intervalMs: DEADLINE_REFRESH_MID_MS,
      freshnessWindowMs: DEADLINE_REFRESH_MID_MS,
    };
  }
  return {
    intervalMs: DEADLINE_REFRESH_FAR_MS,
    freshnessWindowMs: DEADLINE_REFRESH_FAR_MS,
  };
}

export interface AuthoritativeDeadlineSnapshot {
  cluster: string;
  programId: string;
  owner: PublicKey;
  vault: PublicKey;
  heartbeat: PublicKey;
  slot: number;
  chainUnixTime: number;
  lastHeartbeat: number;
  lastMethod: number;
  totalHeartbeats: bigint;
  heartbeatInterval: number;
  gracePeriod: number;
  nextDue: number;
  stage1End: number;
  stage2End: number;
  finalDeadline: number;
  secondsUntilDue: number;
  secondsOverdue: number;
  secondsUntilFinalDeadline: number;
  stage: EscalationStage;
  executableByTime: boolean;
  observedAtMonotonicMs: number;
}

export type AuthoritativeDeadlineResult =
  | ({ status: 'verified' } & AuthoritativeDeadlineSnapshot)
  | { status: 'vault_missing' }
  | { status: 'vault_inactive' }
  | { status: 'vault_executed' }
  | { status: 'rpc_unavailable' }
  | { status: 'chain_time_unavailable' }
  | { status: 'chain_time_invalid' }
  | { status: 'chain_time_regressed' }
  | { status: 'invalid_on_chain_state'; reason: string }
  | { status: 'stage_configuration_invalid'; reason: string };

export type DeadlineProjectionResult =
  | {
      status: 'verified_current' | 'verified_projected';
      snapshot: AuthoritativeDeadlineSnapshot;
    }
  | {
      status: 'stale';
      reason:
        | 'freshness_window_exceeded'
        | 'monotonic_clock_regressed'
        | 'monotonic_clock_invalid';
      lastVerified: AuthoritativeDeadlineSnapshot;
    }
  | {
      status: 'stage4_refresh_required';
      lastVerified: AuthoritativeDeadlineSnapshot;
    };

export interface ChainTimeReaderDependencies {
  getSlot: (commitment: 'confirmed') => Promise<number>;
  getBlockTime: (slot: number) => Promise<number | null>;
}

export interface OnChainDeadlineDependencies {
  cluster: string;
  programId: PublicKey;
  stageDurations: DeadlineStageDurations;
  deriveVaultPda: (owner: PublicKey) => [PublicKey, number];
  deriveHeartbeatPda: (vault: PublicKey) => [PublicKey, number];
  fetchAccount: (
    address: PublicKey,
    minContextSlot: number,
  ) => Promise<AccountInfoLike | null>;
  parseVaultAccount: (account: AccountInfoLike) => RawVaultConfig | null;
  parseHeartbeatAccount: (
    account: AccountInfoLike,
  ) => RawHeartbeatRecord | null;
  getConfirmedChainTime: () => Promise<ConfirmedChainTimeResult>;
  monotonicNowMs: () => number;
}

export interface OnChainDeadlineService {
  fetch: (owner: PublicKey) => Promise<AuthoritativeDeadlineResult>;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function isSafePositiveInteger(value: unknown): value is number {
  return isSafeNonNegativeInteger(value) && value > 0;
}

function checkedAdd(left: number, right: number): number | null {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) {
    return null;
  }
  const result = left + right;
  return Number.isSafeInteger(result) ? result : null;
}

function toSafeOnChainInteger(
  value: { toNumber: () => number },
): number | null {
  try {
    const converted = value.toNumber();
    return isSafeNonNegativeInteger(converted) ? converted : null;
  } catch {
    return null;
  }
}

function validateStageDurations(
  durations: DeadlineStageDurations,
  gracePeriod: number,
): string | null {
  if (
    !isSafePositiveInteger(durations.stage1Duration) ||
    !isSafePositiveInteger(durations.stage2Duration) ||
    !isSafePositiveInteger(durations.stage3Duration)
  ) {
    return 'warning-stage durations must be positive safe integers';
  }
  const firstTwo = checkedAdd(
    durations.stage1Duration,
    durations.stage2Duration,
  );
  const total =
    firstTwo === null
      ? null
      : checkedAdd(firstTwo, durations.stage3Duration);
  if (total === null) {
    return 'warning-stage duration sum exceeds safe numeric bounds';
  }
  if (total !== gracePeriod) {
    return 'warning-stage duration sum does not equal on-chain grace period';
  }
  return null;
}

export function calculateDeadlineSnapshot(input: {
  cluster: string;
  programId: string;
  owner: PublicKey;
  vault: PublicKey;
  heartbeat: PublicKey;
  slot: number;
  chainUnixTime: number;
  lastHeartbeat: number;
  lastMethod: number;
  totalHeartbeats: bigint;
  heartbeatInterval: number;
  gracePeriod: number;
  stageDurations: DeadlineStageDurations;
  observedAtMonotonicMs: number;
}): AuthoritativeDeadlineResult {
  if (
    !isSafeNonNegativeInteger(input.slot) ||
    !isSafeNonNegativeInteger(input.chainUnixTime) ||
    !isSafeNonNegativeInteger(input.lastHeartbeat) ||
    !isSafePositiveInteger(input.heartbeatInterval) ||
    !isSafePositiveInteger(input.gracePeriod) ||
    !Number.isInteger(input.lastMethod) ||
    input.lastMethod < 0 ||
    input.lastMethod > 4 ||
    typeof input.totalHeartbeats !== 'bigint' ||
    input.totalHeartbeats < 0n ||
    !Number.isFinite(input.observedAtMonotonicMs) ||
    input.observedAtMonotonicMs < 0
  ) {
    return {
      status: 'invalid_on_chain_state',
      reason: 'deadline inputs are outside safe numeric bounds',
    };
  }

  const stageError = validateStageDurations(
    input.stageDurations,
    input.gracePeriod,
  );
  if (stageError) {
    return {
      status: 'stage_configuration_invalid',
      reason: stageError,
    };
  }

  const nextDue = checkedAdd(
    input.lastHeartbeat,
    input.heartbeatInterval,
  );
  const finalDeadline =
    nextDue === null ? null : checkedAdd(nextDue, input.gracePeriod);
  const stage1End =
    nextDue === null
      ? null
      : checkedAdd(nextDue, input.stageDurations.stage1Duration);
  const stage2End =
    stage1End === null
      ? null
      : checkedAdd(stage1End, input.stageDurations.stage2Duration);
  if (
    nextDue === null ||
    finalDeadline === null ||
    stage1End === null ||
    stage2End === null
  ) {
    return {
      status: 'invalid_on_chain_state',
      reason: 'deadline arithmetic exceeds safe numeric bounds',
    };
  }

  let stage: EscalationStage;
  if (input.chainUnixTime <= nextDue) {
    stage = 0;
  } else if (input.chainUnixTime < stage1End) {
    stage = 1;
  } else if (input.chainUnixTime < stage2End) {
    stage = 2;
  } else if (input.chainUnixTime < finalDeadline) {
    stage = 3;
  } else {
    stage = 4;
  }

  return {
    status: 'verified',
    cluster: input.cluster,
    programId: input.programId,
    owner: input.owner,
    vault: input.vault,
    heartbeat: input.heartbeat,
    slot: input.slot,
    chainUnixTime: input.chainUnixTime,
    lastHeartbeat: input.lastHeartbeat,
    lastMethod: input.lastMethod,
    totalHeartbeats: input.totalHeartbeats,
    heartbeatInterval: input.heartbeatInterval,
    gracePeriod: input.gracePeriod,
    nextDue,
    stage1End,
    stage2End,
    finalDeadline,
    secondsUntilDue: Math.max(0, nextDue - input.chainUnixTime),
    secondsOverdue: Math.max(0, input.chainUnixTime - nextDue),
    secondsUntilFinalDeadline: Math.max(
      0,
      finalDeadline - input.chainUnixTime,
    ),
    stage,
    executableByTime: input.chainUnixTime >= finalDeadline,
    observedAtMonotonicMs: input.observedAtMonotonicMs,
  };
}

export function createConfirmedChainTimeReader(
  dependencies: ChainTimeReaderDependencies,
): () => Promise<ConfirmedChainTimeResult> {
  return async () => {
    let slot: number;
    try {
      slot = await dependencies.getSlot('confirmed');
    } catch {
      return { status: 'rpc_unavailable' };
    }
    if (!isSafeNonNegativeInteger(slot)) {
      return { status: 'chain_time_invalid' };
    }
    let unixTimestamp: number | null;
    try {
      unixTimestamp = await dependencies.getBlockTime(slot);
    } catch {
      return { status: 'rpc_unavailable' };
    }
    if (unixTimestamp === null) {
      return { status: 'chain_time_unavailable' };
    }
    if (!isSafeNonNegativeInteger(unixTimestamp)) {
      return { status: 'chain_time_invalid' };
    }
    return { status: 'verified', slot, unixTimestamp };
  };
}

export function projectAuthoritativeDeadline(
  snapshot: AuthoritativeDeadlineSnapshot,
  monotonicNowMs: number,
  freshnessWindowMs: number = DEADLINE_FRESHNESS_WINDOW_MS,
): DeadlineProjectionResult {
  if (
    !Number.isFinite(monotonicNowMs) ||
    monotonicNowMs < 0 ||
    !isSafePositiveInteger(freshnessWindowMs)
  ) {
    return {
      status: 'stale',
      reason: 'monotonic_clock_invalid',
      lastVerified: snapshot,
    };
  }
  const elapsedMs = monotonicNowMs - snapshot.observedAtMonotonicMs;
  if (elapsedMs < 0) {
    return {
      status: 'stale',
      reason: 'monotonic_clock_regressed',
      lastVerified: snapshot,
    };
  }
  if (elapsedMs > freshnessWindowMs) {
    return {
      status: 'stale',
      reason: 'freshness_window_exceeded',
      lastVerified: snapshot,
    };
  }
  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  if (elapsedSeconds === 0) {
    return { status: 'verified_current', snapshot };
  }
  const projectedTime = checkedAdd(
    snapshot.chainUnixTime,
    elapsedSeconds,
  );
  if (projectedTime === null) {
    return {
      status: 'stale',
      reason: 'monotonic_clock_invalid',
      lastVerified: snapshot,
    };
  }
  if (
    snapshot.chainUnixTime < snapshot.finalDeadline &&
    projectedTime >= snapshot.finalDeadline
  ) {
    return {
      status: 'stage4_refresh_required',
      lastVerified: snapshot,
    };
  }
  let stage: EscalationStage;
  if (snapshot.stage === 4) {
    stage = 4;
  } else if (projectedTime <= snapshot.nextDue) {
    stage = 0;
  } else if (projectedTime < snapshot.stage1End) {
    stage = 1;
  } else if (projectedTime < snapshot.stage2End) {
    stage = 2;
  } else {
    stage = 3;
  }
  return {
    status: 'verified_projected',
    snapshot: {
      ...snapshot,
      chainUnixTime: projectedTime,
      secondsUntilDue: Math.max(0, snapshot.nextDue - projectedTime),
      secondsOverdue: Math.max(0, projectedTime - snapshot.nextDue),
      secondsUntilFinalDeadline: Math.max(
        0,
        snapshot.finalDeadline - projectedTime,
      ),
      stage,
      executableByTime: false,
    },
  };
}

export function createOnChainDeadlineService(
  dependencies: OnChainDeadlineDependencies,
): OnChainDeadlineService {
  let lastObservation: ConfirmedChainTime | null = null;

  return {
    fetch: async (owner) => {
      let vault: PublicKey;
      let heartbeat: PublicKey;
      let vaultBump: number;
      let heartbeatBump: number;
      try {
        [vault, vaultBump] = dependencies.deriveVaultPda(owner);
        [heartbeat, heartbeatBump] =
          dependencies.deriveHeartbeatPda(vault);
      } catch {
        return {
          status: 'invalid_on_chain_state',
          reason: 'canonical PDA derivation failed',
        };
      }

      const chainTime = await dependencies.getConfirmedChainTime();
      if (chainTime.status !== 'verified') {
        return chainTime;
      }
      if (
        lastObservation &&
        (chainTime.slot < lastObservation.slot ||
          chainTime.unixTimestamp < lastObservation.unixTimestamp)
      ) {
        return { status: 'chain_time_regressed' };
      }

      let observedAtMonotonicMs: number;
      try {
        observedAtMonotonicMs = dependencies.monotonicNowMs();
      } catch {
        return { status: 'chain_time_invalid' };
      }

      let vaultAccount: AccountInfoLike | null;
      try {
        vaultAccount = await dependencies.fetchAccount(
          vault,
          chainTime.slot,
        );
      } catch {
        return { status: 'rpc_unavailable' };
      }
      if (!vaultAccount) return { status: 'vault_missing' };

      const vaultConfig =
        dependencies.parseVaultAccount(vaultAccount);
      if (!vaultConfig) {
        return {
          status: 'invalid_on_chain_state',
          reason: 'vault account validation failed',
        };
      }
      if (
        !vaultConfig.owner.equals(owner) ||
        vaultConfig.bump !== vaultBump
      ) {
        return {
          status: 'invalid_on_chain_state',
          reason: 'vault identity is not canonical',
        };
      }
      if (vaultConfig.executed) return { status: 'vault_executed' };
      if (!vaultConfig.active) return { status: 'vault_inactive' };

      let heartbeatAccount: AccountInfoLike | null;
      try {
        heartbeatAccount = await dependencies.fetchAccount(
          heartbeat,
          chainTime.slot,
        );
      } catch {
        return { status: 'rpc_unavailable' };
      }
      if (!heartbeatAccount) {
        return {
          status: 'invalid_on_chain_state',
          reason: 'canonical heartbeat account is missing',
        };
      }
      const heartbeatRecord =
        dependencies.parseHeartbeatAccount(heartbeatAccount);
      if (!heartbeatRecord) {
        return {
          status: 'invalid_on_chain_state',
          reason: 'heartbeat account validation failed',
        };
      }
      if (
        !heartbeatRecord.vault.equals(vault) ||
        heartbeatRecord.bump !== heartbeatBump
      ) {
        return {
          status: 'invalid_on_chain_state',
          reason: 'heartbeat identity is not canonical',
        };
      }

      const heartbeatInterval = toSafeOnChainInteger(
        vaultConfig.heartbeatInterval,
      );
      const gracePeriod = toSafeOnChainInteger(
        vaultConfig.gracePeriod,
      );
      const lastHeartbeat = toSafeOnChainInteger(
        heartbeatRecord.lastHeartbeat,
      );
      if (
        heartbeatInterval === null ||
        gracePeriod === null ||
        lastHeartbeat === null
      ) {
        return {
          status: 'invalid_on_chain_state',
          reason: 'on-chain deadline values exceed safe numeric bounds',
        };
      }

      const result = calculateDeadlineSnapshot({
        cluster: dependencies.cluster,
        programId: dependencies.programId.toBase58(),
        owner,
        vault,
        heartbeat,
        slot: chainTime.slot,
        chainUnixTime: chainTime.unixTimestamp,
        lastHeartbeat,
        lastMethod: heartbeatRecord.lastMethod,
        totalHeartbeats: heartbeatRecord.totalHeartbeats,
        heartbeatInterval,
        gracePeriod,
        stageDurations: dependencies.stageDurations,
        observedAtMonotonicMs,
      });
      if (result.status === 'verified') {
        lastObservation = {
          slot: chainTime.slot,
          unixTimestamp: chainTime.unixTimestamp,
        };
      }
      return result;
    },
  };
}
