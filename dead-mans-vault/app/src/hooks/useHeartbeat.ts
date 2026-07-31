import { useEffect, useCallback, useRef, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { HeartbeatMethod, HeartbeatStatus, HeartbeatConfig, EscalationStage } from '../types';
import { HeartbeatService } from '../services/HeartbeatService';
import { EscalationService } from '../services/EscalationService';
import { ExecutionService } from '../services/ExecutionService';
import { useHeartbeatStore } from '../store/useHeartbeatStore';
import { useEscalationStore } from '../store/useEscalationStore';
import { useVaultStore } from '../store/useVaultStore';
import { useDemoStore } from '../store/useDemoStore';
import { NotificationService } from '../notifications/NotificationService';
import { getSetting } from '../db/settingsRepo';
import { successKey } from '../services/NotificationRegistrationService';
import { isDevnet } from '../utils/rpcConfig';
import { ESCALATION_DEFAULTS, HEARTBEAT_INTERVALS, PROGRAM_ID } from '../utils/constants';
import type { ConfirmedHeartbeatInsert } from '../db/heartbeatRepoCore';

const DEFAULT_CONFIG: HeartbeatConfig = {
  methods: ['active_tap'],
  intervalSeconds: HEARTBEAT_INTERVALS.weekly,
};

// Demo/dev escalation timers (30s/stage). Exported so the deliberate signed-
// registration flow (Settings) registers the SAME stage durations the app uses.
export const DEV_ESCALATION = {
  stage1Duration: 30,
  stage2Duration: 30,
  stage3Duration: 30,
  emergencyContacts: [] as any[],
};

interface UseHeartbeatResult {
  recordConfirmedHeartbeat: (
    input: ConfirmedHeartbeatInsert,
  ) => Promise<void>;
  resetAfterConfirmedHeartbeat: () => void;
  sendConfirmedHeartbeatNotification: (
    nextDueDate: Date,
  ) => Promise<void>;
  status: HeartbeatStatus | null;
  escalationStage: EscalationStage;
  secondsRemaining: number;
  isMonitoring: boolean;
}

export function useHeartbeat(vaultActive: boolean, ownerPubkey: PublicKey | null = null): UseHeartbeatResult {
  const heartbeatConfig = useHeartbeatStore((s) => s.config) ?? DEFAULT_CONFIG;
  const heartbeatStatus = useHeartbeatStore((s) => s.status);
  const escalationState = useEscalationStore((s) => s.state);
  const isDemoMode = useDemoStore((s) => s.isDemoMode);

  const heartbeatServiceRef = useRef<HeartbeatService | null>(null);
  const escalationServiceRef = useRef<EscalationService | null>(null);
  const refreshIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [isMonitoring, setIsMonitoring] = useState(false);
  const [secondsRemaining, setSecondsRemaining] = useState(0);

  // Create/destroy services based on vault active state
  useEffect(() => {
    if (!vaultActive) {
      // Clean up services if vault becomes inactive
      if (escalationServiceRef.current) {
        escalationServiceRef.current.stop();
        escalationServiceRef.current = null;
      }
      if (heartbeatServiceRef.current) {
        heartbeatServiceRef.current.destroy();
        heartbeatServiceRef.current = null;
      }
      setIsMonitoring(false);
      return;
    }

    // Create services
    const hbService = new HeartbeatService(heartbeatConfig);
    heartbeatServiceRef.current = hbService;

    const useDevTimers = __DEV__ || isDemoMode;
    const escConfig = useDevTimers
      ? DEV_ESCALATION
      : {
          stage1Duration: ESCALATION_DEFAULTS.stage1,
          stage2Duration: ESCALATION_DEFAULTS.stage2,
          stage3Duration: ESCALATION_DEFAULTS.stage3,
          emergencyContacts: [],
        };

    const escService = new EscalationService(hbService, escConfig);
    escService.setBeneficiaryCount(useVaultStore.getState().beneficiaries.length);
    escalationServiceRef.current = escService;

    // Wire execution callback — fires when Stage 4 is reached
    if (ownerPubkey) {
      escService.setExecutionCallback(async () => {
        try {
          const currentState = useVaultStore.getState();
          const executionService = new ExecutionService(
            ownerPubkey,
            currentState.beneficiaries,
          );
          await executionService.execute();
        } catch {
          // Execution failure handled internally by ExecutionService step tracking
        }
      });
    }

    escService.start();
    setIsMonitoring(true);

    // WP5: signed notification registration is a DELIBERATE user action (Settings),
    // never a background call. Heartbeat only READS the local persisted signed-
    // registration record to reflect whether server-driven escalation is active —
    // it acquires NO device token, requests NO wallet signature, and makes NO
    // /register request. Whether server-driven escalation is active follows from the
    // owner having completed signed registration — there is NO local timeline fallback
    // when it hasn't (see EscalationService.scheduleBackgroundTimeline, cancel-only).
    if (ownerPubkey) {
      try {
        const [vaultPda] = PublicKey.findProgramAddressSync(
          [Buffer.from('vault'), ownerPubkey.toBuffer()],
          new PublicKey(PROGRAM_ID),
        );
        const cluster = isDevnet() ? 'devnet' : 'mainnet-beta';
        getSetting(
          successKey({ cluster, programId: PROGRAM_ID, owner: ownerPubkey.toBase58(), vault: vaultPda.toBase58() }),
        )
          .then((record) => escService.setFcmActive(!!record))
          .catch(() => escService.setFcmActive(false));
      } catch {
        escService.setFcmActive(false);
      }
    }

    // Refresh heartbeat status for UI every 10s
    const refreshStatus = async () => {
      try {
        const status = await hbService.getStatus();
        useHeartbeatStore.getState().setStatus(status);

        if (status.isOverdue) {
          const totalGrace = escConfig.stage1Duration + escConfig.stage2Duration + escConfig.stage3Duration;
          setSecondsRemaining(Math.max(0, totalGrace - status.secondsOverdue));
        } else {
          setSecondsRemaining(0);
        }
      } catch {
        // Non-fatal
      }
    };

    refreshStatus();
    refreshIntervalRef.current = setInterval(refreshStatus, 10_000);

    // 1-second ticker for smooth countdown display
    tickIntervalRef.current = setInterval(() => {
      setSecondsRemaining((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);

    return () => {
      escService.stop();
      hbService.destroy();
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current);
        refreshIntervalRef.current = null;
      }
      if (tickIntervalRef.current) {
        clearInterval(tickIntervalRef.current);
        tickIntervalRef.current = null;
      }
      setIsMonitoring(false);
    };
  }, [vaultActive, heartbeatConfig, isDemoMode, ownerPubkey]);

  const recordConfirmedHeartbeat = useCallback(
    async (input: ConfirmedHeartbeatInsert) => {
      if (!heartbeatServiceRef.current) {
        throw new Error('Heartbeat service is unavailable');
      }
      await heartbeatServiceRef.current.recordConfirmedHeartbeat(input);
    },
    [],
  );

  const resetAfterConfirmedHeartbeat = useCallback(() => {
    if (escalationServiceRef.current) {
      escalationServiceRef.current.resetEscalation();
    }
    setSecondsRemaining(0);
  }, []);

  const sendConfirmedHeartbeatNotification = useCallback(
    (nextDueDate: Date) =>
      NotificationService.sendHeartbeatConfirmed(nextDueDate),
    [],
  );

  return {
    recordConfirmedHeartbeat,
    resetAfterConfirmedHeartbeat,
    sendConfirmedHeartbeatNotification,
    status: heartbeatStatus,
    escalationStage: escalationState.stage,
    secondsRemaining,
    isMonitoring,
  };
}
