import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState } from 'react-native';
import type { PublicKey } from '@solana/web3.js';
import type {
  HeartbeatConfig,
  EscalationStage,
} from '../types';
import { HeartbeatService } from '../services/HeartbeatService';
import { EscalationService } from '../services/EscalationService';
import { ExecutionService } from '../services/ExecutionService';
import { useHeartbeatStore } from '../store/useHeartbeatStore';
import { useEscalationStore } from '../store/useEscalationStore';
import { useVaultStore } from '../store/useVaultStore';
import { useDemoStore } from '../store/useDemoStore';
import { NotificationService } from '../notifications/NotificationService';
import { HEARTBEAT_INTERVALS } from '../utils/constants';
import type { ConfirmedHeartbeatInsert } from '../db/heartbeatRepoCore';
import type { AuthoritativeHeartbeatCacheInput } from '../db/heartbeatRepo';
import {
  createDefaultOnChainDeadlineService,
  getMonotonicNowMs,
} from '../services/DefaultOnChainDeadlineService';
import {
  projectAuthoritativeDeadline,
  type AuthoritativeDeadlineResult,
  type AuthoritativeDeadlineSnapshot,
} from '../services/OnChainDeadlineService';
import {
  getDeadlineStageDurations,
} from '../utils/deadlineStageConfig';

const DEFAULT_CONFIG: HeartbeatConfig = {
  methods: ['active_tap'],
  intervalSeconds: HEARTBEAT_INTERVALS.weekly,
};

export type DeadlineUiState =
  | {
      status: 'verified_current' | 'verified_projected';
      snapshot: AuthoritativeDeadlineSnapshot;
    }
  | {
      status:
        | 'checking'
        | 'stale'
        | 'rpc_unavailable'
        | 'chain_time_unavailable'
        | 'invalid_on_chain_state'
        | 'stage_configuration_invalid'
        | 'vault_executed'
        | 'vault_inactive'
        | 'vault_missing';
      lastVerified: AuthoritativeDeadlineSnapshot | null;
    };

interface UseHeartbeatResult {
  recordConfirmedHeartbeat: (
    input: ConfirmedHeartbeatInsert,
  ) => Promise<void>;
  recordAuthoritativeUnattributedHeartbeat: (
    input: AuthoritativeHeartbeatCacheInput,
  ) => Promise<void>;
  refreshAuthoritativeDeadline: () => Promise<void>;
  sendConfirmedHeartbeatNotification: (
    nextDueDate: Date,
  ) => Promise<void>;
  deadlineState: DeadlineUiState;
  escalationStage: EscalationStage;
  secondsRemaining: number;
  isMonitoring: boolean;
}

function unavailableDeadlineState(
  result: Exclude<AuthoritativeDeadlineResult, { status: 'verified' }>,
  lastVerified: AuthoritativeDeadlineSnapshot | null,
): DeadlineUiState {
  switch (result.status) {
    case 'vault_executed':
    case 'vault_inactive':
    case 'vault_missing':
    case 'stage_configuration_invalid':
      return { status: result.status, lastVerified };
    case 'rpc_unavailable':
      return { status: 'rpc_unavailable', lastVerified };
    case 'chain_time_unavailable':
    case 'chain_time_invalid':
    case 'chain_time_regressed':
      return { status: 'chain_time_unavailable', lastVerified };
    case 'invalid_on_chain_state':
      return { status: 'invalid_on_chain_state', lastVerified };
  }
}

export function useHeartbeat(
  vaultActive: boolean,
  ownerPubkey: PublicKey | null = null,
): UseHeartbeatResult {
  const heartbeatConfig =
    useHeartbeatStore((state) => state.config) ?? DEFAULT_CONFIG;
  const escalationState = useEscalationStore((state) => state.state);
  const escalationConfig = useVaultStore(
    (state) => state.escalationConfig,
  );
  const beneficiaries = useVaultStore((state) => state.beneficiaries);
  const isDemoMode = useDemoStore((state) => state.isDemoMode);
  const stageDurations = useMemo(
    () =>
      getDeadlineStageDurations(isDemoMode, escalationConfig),
    [escalationConfig, isDemoMode],
  );

  const ownerRef = useRef<PublicKey | null>(ownerPubkey);
  ownerRef.current = ownerPubkey;
  const heartbeatServiceRef = useRef<HeartbeatService | null>(null);
  const deadlineServiceRef = useRef<ReturnType<
    typeof createDefaultOnChainDeadlineService
  > | null>(null);
  const escalationServiceRef = useRef<EscalationService | null>(null);
  const lastVerifiedRef =
    useRef<AuthoritativeDeadlineSnapshot | null>(null);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const generationRef = useRef(0);

  const [isMonitoring, setIsMonitoring] = useState(false);
  const [secondsRemaining, setSecondsRemaining] = useState(0);
  const [deadlineState, setDeadlineState] =
    useState<DeadlineUiState>({
      status: 'checking',
      lastVerified: null,
    });

  const refreshAuthoritativeDeadline = useCallback(async () => {
    const existing = refreshInFlightRef.current;
    if (existing) return existing;

    const service = deadlineServiceRef.current;
    const owner = ownerRef.current;
    if (!service || !owner) return;
    const generation = generationRef.current;
    const ownerIdentity = owner.toBase58();
    const task = (async () => {
      setDeadlineState((current) => ({
        status: 'checking',
        lastVerified:
          'snapshot' in current
            ? current.snapshot
            : current.lastVerified,
      }));
      const result = await service.fetch(owner);
      if (
        generation !== generationRef.current ||
        ownerRef.current?.toBase58() !== ownerIdentity
      ) {
        return;
      }
      if (result.status === 'verified') {
        lastVerifiedRef.current = result;
        setDeadlineState({
          status: 'verified_current',
          snapshot: result,
        });
        setSecondsRemaining(
          result.stage === 0
            ? 0
            : result.secondsUntilFinalDeadline,
        );
        escalationServiceRef.current?.applyAuthoritativeSnapshot(
          result,
        );
        return;
      }

      escalationServiceRef.current?.markAuthorityUnavailable();
      if (result.status === 'vault_executed') {
        useEscalationStore.getState().reset();
        setSecondsRemaining(0);
      }
      setDeadlineState(
        unavailableDeadlineState(result, lastVerifiedRef.current),
      );
    })().finally(() => {
      if (refreshInFlightRef.current === task) {
        refreshInFlightRef.current = null;
      }
    });
    refreshInFlightRef.current = task;
    return task;
  }, []);

  useEffect(() => {
    generationRef.current += 1;
    // An older identity's in-flight read cannot be cancelled, but generation
    // checks discard it. Do not let that promise suppress this identity's read.
    refreshInFlightRef.current = null;
    const generation = generationRef.current;
    if (!vaultActive || !ownerPubkey) {
      heartbeatServiceRef.current?.destroy();
      heartbeatServiceRef.current = null;
      deadlineServiceRef.current = null;
      escalationServiceRef.current?.resetForIdentityChange();
      escalationServiceRef.current = null;
      lastVerifiedRef.current = null;
      setDeadlineState({
        status: 'checking',
        lastVerified: null,
      });
      setSecondsRemaining(0);
      setIsMonitoring(false);
      return;
    }

    const historyService = new HeartbeatService(heartbeatConfig);
    const deadlineService =
      createDefaultOnChainDeadlineService(stageDurations);
    const escalationService = new EscalationService({
      state: {
        getStage: () =>
          useEscalationStore.getState().state.stage,
        resetNonTerminal: () =>
          useEscalationStore.getState().reset(),
        setStage: (stage, observedChainTime) =>
          useEscalationStore
            .getState()
            .setStage(stage, observedChainTime),
        setExecutionDeadline: (deadline) =>
          useEscalationStore
            .getState()
            .setExecutionDeadline(deadline),
        setExecutionStarted: (started) =>
          useEscalationStore
            .getState()
            .setExecutionStarted(started),
      },
    });
    heartbeatServiceRef.current = historyService;
    deadlineServiceRef.current = deadlineService;
    escalationServiceRef.current = escalationService;
    lastVerifiedRef.current = null;

    escalationService.setExecutionCallback(async (snapshot) => {
      if (
        generation !== generationRef.current ||
        ownerRef.current?.toBase58() !==
          snapshot.owner.toBase58()
      ) {
        return;
      }
      const executionService = new ExecutionService(
        snapshot.owner,
        beneficiaries,
      );
      await executionService.execute();
    });

    // Cancel remnants from pre-v1.7.3 installs. This is cancel-only:
    // Stage 1–3 pushes are notify-server-only and no local fallback is armed.
    NotificationService.cancelEscalationTimeline().catch(() => {});
    setIsMonitoring(true);
    void refreshAuthoritativeDeadline();

    const refreshTimer = setInterval(() => {
      void refreshAuthoritativeDeadline();
    }, 30_000);

    const projectionTimer = setInterval(() => {
      const lastVerified = lastVerifiedRef.current;
      if (!lastVerified) return;
      let projection;
      try {
        projection = projectAuthoritativeDeadline(
          lastVerified,
          getMonotonicNowMs(),
        );
      } catch {
        projection = {
          status: 'stale' as const,
          reason: 'monotonic_clock_invalid' as const,
          lastVerified,
        };
      }
      if (projection.status === 'stage4_refresh_required') {
        setDeadlineState({
          status: 'checking',
          lastVerified,
        });
        escalationService.markAuthorityUnavailable();
        void refreshAuthoritativeDeadline();
        return;
      }
      if (projection.status === 'stale') {
        setDeadlineState({ status: 'stale', lastVerified });
        escalationService.markAuthorityUnavailable();
        return;
      }
      setDeadlineState(projection);
      setSecondsRemaining(
        projection.snapshot.stage === 0
          ? 0
          : projection.snapshot.secondsUntilFinalDeadline,
      );
      if (projection.status === 'verified_projected') {
        escalationService.applyProjectedSnapshot(
          projection.snapshot,
        );
      }
    }, 1_000);

    const appStateSubscription = AppState.addEventListener(
      'change',
      (state) => {
        if (state === 'active') {
          void refreshAuthoritativeDeadline();
        }
      },
    );

    return () => {
      generationRef.current += 1;
      clearInterval(refreshTimer);
      clearInterval(projectionTimer);
      appStateSubscription.remove();
      historyService.destroy();
      if (heartbeatServiceRef.current === historyService) {
        heartbeatServiceRef.current = null;
      }
      if (deadlineServiceRef.current === deadlineService) {
        deadlineServiceRef.current = null;
      }
      if (escalationServiceRef.current === escalationService) {
        escalationServiceRef.current = null;
      }
      setIsMonitoring(false);
    };
  }, [
    beneficiaries,
    heartbeatConfig,
    ownerPubkey,
    refreshAuthoritativeDeadline,
    stageDurations,
    vaultActive,
  ]);

  const recordConfirmedHeartbeat = useCallback(
    async (input: ConfirmedHeartbeatInsert) => {
      if (!heartbeatServiceRef.current) {
        throw new Error('Heartbeat history service is unavailable');
      }
      await heartbeatServiceRef.current.recordConfirmedHeartbeat(input);
    },
    [],
  );

  const recordAuthoritativeUnattributedHeartbeat = useCallback(
    async (input: AuthoritativeHeartbeatCacheInput) => {
      if (!heartbeatServiceRef.current) {
        throw new Error('Heartbeat history service is unavailable');
      }
      await heartbeatServiceRef.current
        .recordAuthoritativeUnattributedHeartbeat(input);
    },
    [],
  );

  const sendConfirmedHeartbeatNotification = useCallback(
    (nextDueDate: Date) =>
      NotificationService.sendHeartbeatConfirmed(nextDueDate),
    [],
  );

  return {
    recordConfirmedHeartbeat,
    recordAuthoritativeUnattributedHeartbeat,
    refreshAuthoritativeDeadline,
    sendConfirmedHeartbeatNotification,
    deadlineState,
    escalationStage: escalationState.stage,
    secondsRemaining,
    isMonitoring,
  };
}
