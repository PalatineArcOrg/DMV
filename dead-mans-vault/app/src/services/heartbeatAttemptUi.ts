import type { HeartbeatAttemptResult } from './HeartbeatCoordinator';

export type HeartbeatAttemptMessageTone =
  | 'pending'
  | 'warning'
  | 'critical'
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
      if (result.localSync !== 'complete') {
        return {
          tone: 'warning',
          text:
            'Heartbeat confirmed on Solana. This device could not update its local history, ' +
            'but your on-chain liveness deadline was reset successfully.',
        };
      }
      if (result.feeReadiness === 'low_reserve') {
        return {
          tone: 'warning',
          text:
            'Heartbeat confirmed on Solana. The agent can pay for this heartbeat, ' +
            'but its SOL reserve is running low.',
        };
      }
      if (result.feeReadiness === 'check_unavailable') {
        return {
          tone: 'warning',
          text:
            'Heartbeat confirmed on Solana. The auxiliary agent fee check was unavailable; ' +
            'Solana enforced the actual transaction fee.',
        };
      }
      return null;
    case 'heartbeat_in_flight':
      return {
        tone: 'pending',
        text: 'Heartbeat verification is already in progress.',
      };
    case 'heartbeat_still_pending':
      return {
        tone: 'pending',
        text:
          'A heartbeat transaction is already pending reconciliation. ' +
          'No new transaction will be submitted.',
      };
    case 'heartbeat_reconciliation_unavailable':
      return {
        tone: 'warning',
        text:
          'The existing heartbeat transaction could not be checked. ' +
          'No new transaction was submitted.',
      };
    case 'heartbeat_reconciled_confirmed':
      return {
        tone: 'pending',
        text:
          'The previously submitted heartbeat was confirmed on Solana ' +
          'and your liveness deadline has been updated.',
      };
    case 'heartbeat_reconciled_local_sync_pending':
      return {
        tone: 'warning',
        text:
          'The previous heartbeat is confirmed on Solana, but this device ' +
          'still needs to repair its local history. Do not submit it again.',
      };
    case 'heartbeat_reconciled_failed':
      return {
        tone: 'warning',
        text:
          'The previous heartbeat transaction failed on-chain. ' +
          'No heartbeat was recorded. You may try again.',
      };
    case 'heartbeat_reconciled_expired':
      return {
        tone: 'warning',
        text:
          'The previous heartbeat transaction expired without landing. ' +
          'No heartbeat was recorded. You may try again.',
      };
    case 'heartbeat_reconciled_chain_advanced':
      return {
        tone: 'pending',
        text:
          'The on-chain heartbeat state advanced, but this device could not ' +
          'verify which transaction caused it. Liveness is current; the ' +
          'pending transaction was not marked as confirmed.',
      };
    case 'invalid_local_record':
      return {
        tone: 'critical',
        text:
          'The saved heartbeat recovery record is invalid. No transaction ' +
          'was submitted. Contact support before trying another heartbeat.',
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
    case 'insufficient_agent_funds':
      return {
        tone: 'critical',
        text:
          'The heartbeat agent does not have enough SOL to submit a heartbeat. ' +
          'No heartbeat transaction was sent.',
      };
    case 'preparation_failed':
      return {
        tone: 'warning',
        text:
          'The heartbeat transaction was not submitted. ' +
          'No local or on-chain heartbeat was recorded.',
      };
    case 'journal_failed':
      return {
        tone: 'critical',
        text:
          'The heartbeat transaction could not be saved safely before submission. ' +
          'No transaction was submitted.',
      };
    case 'submission_unknown':
      return {
        tone: 'critical',
        text:
          'The heartbeat transaction may have been submitted, but the RPC response ' +
          'was inconclusive. Do not tap again while it is being reconciled.',
      };
    case 'transaction_failed':
      return {
        tone: 'warning',
        text:
          'The heartbeat transaction was confirmed as failed. ' +
          'No heartbeat was recorded.',
      };
    case 'confirmation_unknown':
      return {
        tone: 'warning',
        text:
          'The heartbeat transaction was submitted, but its result could not be confirmed. ' +
          'Do not tap again yet. Check the submitted transaction.',
      };
    case 'post_state_unavailable':
    case 'post_state_invalid':
      return {
        tone: 'warning',
        text:
          'The transaction reported success, but the updated heartbeat account could not be verified. ' +
          'Do not submit another heartbeat until the state is reconciled.',
      };
    case 'post_state_not_advanced':
      return {
        tone: 'critical',
        text:
          'Heartbeat integrity warning: the transaction reported success, but the canonical heartbeat record did not advance. ' +
          'Do not submit another heartbeat until the state is reconciled.',
      };
  }
}
