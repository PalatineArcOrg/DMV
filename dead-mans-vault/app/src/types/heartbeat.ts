export type HeartbeatMethod =
  | 'active_tap'
  | 'biometric_confirm'
  | 'on_chain_activity'
  | 'pin_challenge'
  | 'hardware_switch';

export const HEARTBEAT_INSTRUCTION_METHOD: Record<
  HeartbeatMethod,
  | 'activeTap'
  | 'biometricConfirm'
  | 'onChainActivity'
  | 'pinChallenge'
  | 'hardwareSwitch'
> = {
  active_tap: 'activeTap',
  biometric_confirm: 'biometricConfirm',
  on_chain_activity: 'onChainActivity',
  pin_challenge: 'pinChallenge',
  hardware_switch: 'hardwareSwitch',
};

export interface HeartbeatConfig {
  methods: HeartbeatMethod[];
  intervalSeconds: number;
}

export interface HeartbeatStatus {
  lastHeartbeat: number;
  lastMethod: HeartbeatMethod;
  totalHeartbeats: number;
  nextDue: number;
  isOverdue: boolean;
  secondsOverdue: number;
}
