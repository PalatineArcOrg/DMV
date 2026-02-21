import { useEffect, useCallback, useRef, useState } from 'react';
import { HeartbeatMethod, HeartbeatStatus, HeartbeatConfig, EscalationStage } from '../types';
import { HeartbeatService } from '../services/HeartbeatService';
import { EscalationService } from '../services/EscalationService';
import { useHeartbeatStore } from '../store/useHeartbeatStore';
import { useEscalationStore } from '../store/useEscalationStore';
import { useDemoStore } from '../store/useDemoStore';
import { ESCALATION_DEFAULTS, HEARTBEAT_INTERVALS } from '../utils/constants';

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

export function useHeartbeat(vaultActive: boolean): UseHeartbeatResult {
  const heartbeatConfig = useHeartbeatStore((s) => s.config) ?? DEFAULT_CONFIG;
  const heartbeatStatus = useHeartbeatStore((s) => s.status);
  const escalationState = useEscalationStore((s) => s.state);
  const isDemoMode = useDemoStore((s) => s.isDemoMode);

  const heartbeatServiceRef = useRef<HeartbeatService | null>(null);
  const escalationServiceRef = useRef<EscalationService | null>(null);
  const refreshIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
    escalationServiceRef.current = escService;

    escService.start();
    setIsMonitoring(true);

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

    return () => {
      escService.stop();
      hbService.destroy();
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current);
        refreshIntervalRef.current = null;
      }
      setIsMonitoring(false);
    };
  }, [vaultActive, heartbeatConfig, isDemoMode]);

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
      } finally {
        setIsConfirming(false);
      }
    },
    [],
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
