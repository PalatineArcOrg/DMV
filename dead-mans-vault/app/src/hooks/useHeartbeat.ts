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
import { PushRegistrationService } from '../services/PushRegistrationService';
import { ESCALATION_DEFAULTS, HEARTBEAT_INTERVALS, PROGRAM_ID } from '../utils/constants';

const DEFAULT_CONFIG: HeartbeatConfig = {
  methods: ['active_tap'],
  intervalSeconds: HEARTBEAT_INTERVALS.weekly,
};

const DEV_ESCALATION = {
  stage1Duration: 30,
  stage2Duration: 30,
  stage3Duration: 30,
  emergencyContacts: [] as any[],
};

interface UseHeartbeatResult {
  confirmHeartbeat: (method?: HeartbeatMethod) => Promise<void>;
  status: HeartbeatStatus | null;
  escalationStage: EscalationStage;
  secondsRemaining: number;
  isMonitoring: boolean;
  isConfirming: boolean;
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
  const [isConfirming, setIsConfirming] = useState(false);
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

    // Register this device with the FCM notify server so escalation pushes
    // arrive even when the app is killed. Idempotent; the server reads
    // heartbeats from chain, so we only register the token + stage durations.
    // Fire-and-forget and no-ops if push isn't configured in this build.
    if (ownerPubkey) {
      try {
        const [vaultPda] = PublicKey.findProgramAddressSync(
          [Buffer.from('vault'), ownerPubkey.toBuffer()],
          new PublicKey(PROGRAM_ID),
        );
        PushRegistrationService.register(ownerPubkey.toBase58(), vaultPda.toBase58(), {
          stage1: escConfig.stage1Duration,
          stage2: escConfig.stage2Duration,
          stage3: escConfig.stage3Duration,
        }).catch(() => {});
      } catch {
        // Non-fatal — push registration is best-effort.
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

  const confirmHeartbeat = useCallback(
    async (method: HeartbeatMethod = 'active_tap') => {
      if (!heartbeatServiceRef.current) return;
      setIsConfirming(true);
      try {
        await heartbeatServiceRef.current.confirmHeartbeat(method);
        if (escalationServiceRef.current) {
          escalationServiceRef.current.resetEscalation();
        }
        setSecondsRemaining(0);

        // Notify user of successful heartbeat with next due date
        const intervalSeconds = heartbeatConfig?.intervalSeconds ?? 86400;
        const nextDue = new Date(Date.now() + intervalSeconds * 1000);
        try { NotificationService.sendHeartbeatConfirmed(nextDue); } catch {}
      } finally {
        setIsConfirming(false);
      }
    },
    [heartbeatConfig],
  );

  return {
    confirmHeartbeat,
    status: heartbeatStatus,
    escalationStage: escalationState.stage,
    secondsRemaining,
    isMonitoring,
    isConfirming,
  };
}
