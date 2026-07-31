import type { HeartbeatAttemptResult } from './HeartbeatCoordinator';

export type HeartbeatAttemptMessageTone =
  | 'pending'
  | 'warning'
  | 'terminal';

export interface HeartbeatAttemptMessage {
  tone: HeartbeatAttemptMessageTone;
  text: string;
}

export function getHeartbeatAttemptMessage(
  result: HeartbeatAttemptResult,
): HeartbeatAttemptMessage | null {
  switch (result.status) {
    case 'confirmed_on_chain':
      return null;
    case 'heartbeat_in_flight':
      return {
        tone: 'pending',
        text: 'Heartbeat verification is already in progress.',
      };
    case 'owner_missing':
      return {
        tone: 'warning',
        text: 'Connect the vault owner wallet before recording a heartbeat.',
      };
    case 'agent_missing':
      return {
        tone: 'warning',
        text:
          'This device does not have the heartbeat agent key authorised for this vault. ' +
          'Do not uninstall the existing DMV installation or create a replacement key. ' +
          'Agent recovery or owner-authorised rotation is required.',
      };
    case 'agent_unavailable':
      return {
        tone: 'warning',
        text:
          'The device heartbeat key could not be unlocked. No heartbeat was recorded. ' +
          'Authenticate on this device and try again.',
      };
    case 'agent_mismatch':
      return {
        tone: 'warning',
        text:
          'This device’s heartbeat key does not match the agent currently authorised on-chain. ' +
          'No heartbeat was recorded.',
      };
    case 'vault_missing':
      return {
        tone: 'terminal',
        text:
          'No on-chain vault exists for the connected owner. No heartbeat was recorded.',
      };
    case 'vault_inactive':
      return {
        tone: 'terminal',
        text:
          'This vault is inactive and cannot accept heartbeats. No heartbeat was recorded.',
      };
    case 'vault_executed':
      return {
        tone: 'terminal',
        text:
          'This vault has already executed and cannot accept heartbeats.',
      };
    case 'rpc_unavailable':
      return {
        tone: 'warning',
        text:
          'The current on-chain agent state could not be verified. ' +
          'No local or on-chain heartbeat was recorded. Check the network and try again.',
      };
    case 'invalid_on_chain_state':
      return {
        tone: 'warning',
        text:
          'The on-chain vault state could not be validated safely. ' +
          'No local or on-chain heartbeat was recorded.',
      };
    case 'on_chain_failed':
      return {
        tone: 'warning',
        text:
          "On-chain heartbeat didn't record — liveness was not updated on-chain. " +
          'Check the network and try again.',
      };
    case 'local_failed':
      return {
        tone: 'warning',
        text:
          'The local heartbeat record could not be saved, so no on-chain heartbeat was attempted.',
      };
  }
}
