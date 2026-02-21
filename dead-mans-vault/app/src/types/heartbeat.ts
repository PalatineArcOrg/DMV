export type HeartbeatMethod =
  | 'active_tap'
  | 'biometric_confirm'
  | 'on_chain_activity'
  | 'pin_challenge'
  | 'hardware_switch';

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
