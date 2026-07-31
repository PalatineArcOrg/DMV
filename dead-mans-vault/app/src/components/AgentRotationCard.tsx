import React, {
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Alert,
  Linking,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import {
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import { useWallet } from '../hooks/useWallet';
import {
  DefaultAgentRotationService,
  type AgentRotationWalletDependencies,
} from '../services/DefaultAgentRotationService';
import type {
  AgentRotationResult,
} from '../services/AgentRotationCoordinator';
import { KeyManager } from '../tee/KeyManager';
import { COLORS, FONTS } from '../utils/constants';
import { explorerTx } from '../utils/rpcConfig';
import { truncateAddress } from '../utils/formatting';

interface AgentRotationCardProps {
  owner: PublicKey;
}

function isCancellation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('cancel') ||
    message.includes('declin') ||
    message.includes('reject')
  );
}

function confirmAlert(
  title: string,
  message: string,
  action: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      title,
      message,
      [
        {
          text: 'Cancel',
          style: 'cancel',
          onPress: () => resolve(false),
        },
        { text: action, onPress: () => resolve(true) },
      ],
      { cancelable: false },
    );
  });
}

function messageFor(result: AgentRotationResult): string {
  switch (result.status) {
    case 'candidate_secured':
      return (
        'A replacement heartbeat key has been created and stored on ' +
        'this device. Your current agent remains active.'
      );
    case 'confirmed':
      return (
        'The replacement agent is now authorised on-chain. The ' +
        'previous key remains stored temporarily and has not been deleted.'
      );
    case 'rotation_pending':
    case 'submission_unknown':
    case 'confirmation_unknown':
      return (
        'The agent rotation transaction may be pending. No second ' +
        'rotation will be sent until it is reconciled.'
      );
    case 'transaction_failed':
      return (
        'The existing agent remains authorised. The replacement key ' +
        'was not promoted.'
      );
    case 'promotion_failed':
    case 'post_state_unverified':
      return (
        'The rotation result needs recovery. Both stored keys were ' +
        'retained. Do not uninstall the app or clear its data.'
      );
    case 'candidate_not_funded':
      return (
        'The replacement agent needs SOL for the rotation transaction. ' +
        'Funding it does not rotate the vault or count as a heartbeat.'
      );
    case 'heartbeat_operation_pending':
      return (
        'A heartbeat transaction is pending reconciliation. Rotation ' +
        'is paused and no transaction was submitted.'
      );
    case 'candidate_funding_pending':
      return (
        'A candidate-funding transaction is pending reconciliation. ' +
        'No funding or rotation transaction was submitted.'
      );
    case 'active_agent_mismatch':
      return (
        'The on-chain agent does not match the active key stored by ' +
        'this installation. Do not uninstall the app or clear its data.'
      );
    case 'previous_key_cleanup_required':
      return (
        'A previous agent key is still retained for safety. No new ' +
        'rotation can start until a separately authorised cleanup gate.'
      );
    case 'deadline_reached':
      return (
        'The on-chain final deadline has been reached. Agent rotation ' +
        'is frozen and no transaction was submitted.'
      );
    case 'wallet_transaction_modified':
      return (
        'The owner wallet returned a modified transaction. Nothing was ' +
        'journalled or submitted; both keys remain stored.'
      );
    case 'owner_cancelled':
      return 'Owner approval was cancelled. No rotation was submitted.';
    case 'candidate_missing':
      return 'Create and secure a replacement key before rotation.';
    case 'rotation_in_flight':
      return 'An agent-rotation action is already in progress.';
    default:
      return 'Agent rotation is unavailable. No key was removed.';
  }
}

export function AgentRotationCard({
  owner,
}: AgentRotationCardProps) {
  const { signTransaction } = useWallet();
  const service = useRef(new DefaultAgentRotationService()).current;
  const [candidate, setCandidate] = useState<string | null>(null);
  const [message, setMessage] = useState(
    'Create, fund and authorise a replacement agent as separate deliberate actions.',
  );
  const [signature, setSignature] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secondsRemaining, setSecondsRemaining] =
    useState<number | null>(null);

  const walletDependencies =
    useMemo<AgentRotationWalletDependencies>(
      () => ({
        signWithOwnerWallet: async (transaction) => {
          const signed = await signTransaction(transaction);
          if (!(signed instanceof Transaction)) {
            throw new Error(
              'Wallet returned an unexpected transaction type',
            );
          }
          return signed;
        },
        confirmCandidateFunding: (confirmation) =>
          confirmAlert(
            'Fund replacement agent?',
            `Transfer ${(confirmation.transferLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL\n` +
              `Owner network fee ${(confirmation.ownerFeeLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL\n\n` +
              `Candidate ${truncateAddress(confirmation.candidate.toBase58(), 6)}\n\n` +
              'Funding does not rotate the vault and does not count as a heartbeat.',
            'Sign transfer',
          ),
        isOwnerCancellation: isCancellation,
        refreshAuthoritativeDeadline: async () => {},
      }),
      [signTransaction],
    );
  const coordinator = useMemo(
    () => service.createCoordinator(walletDependencies),
    [service, walletDependencies],
  );

  const refreshReadOnly = useCallback(async () => {
    try {
      const stored =
        await KeyManager.getInstance().getCandidatePublicKey();
      setCandidate(stored);
      const preflight = await service.inspect(owner);
      setSecondsRemaining(
        preflight.status === 'ready'
          ? Math.max(
              0,
              preflight.value.finalDeadline -
                preflight.value.state.chainUnixTime,
            )
          : null,
      );
      const result = await service.reconcileForOwner(owner);
      if (!result) return;
      if (
        result.status === 'reconciled_promoted' ||
        result.status === 'reconciled_rotated_unattributed'
      ) {
        setMessage(
          'The replacement agent is authorised on-chain and has been promoted. The previous key remains stored.',
        );
        setCandidate(null);
      } else if (
        result.status === 'reconciled_failed' ||
        result.status === 'reconciled_not_landed'
      ) {
        setMessage(
          'The existing agent remains authorised. The replacement key was not promoted.',
        );
      } else if (result.status === 'recovery_required') {
        setMessage(
          `Recovery required: on-chain agent ${truncateAddress(result.onChainAgent, 6)} does not match the expected rotation keys. Do not uninstall or clear app data.`,
        );
      } else {
        setMessage(
          'A rotation operation is pending reconciliation. No new transaction will be submitted.',
        );
        if ('signature' in result) setSignature(result.signature);
      }
    } catch {
      setSecondsRemaining(null);
      setMessage(
        'Stored rotation state or current chain state could not be verified. Both keys remain stored and no transaction was submitted.',
      );
    }
  }, [owner, service]);

  useFocusEffect(
    useCallback(() => {
      void refreshReadOnly();
      return undefined;
    }, [refreshReadOnly]),
  );

  const run = useCallback(
    async (action: () => Promise<void>) => {
      if (busy) return;
      setBusy(true);
      try {
        await action();
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  const createCandidate = useCallback(
    () =>
      run(async () => {
        if (
          !(await confirmAlert(
            'Create replacement key?',
            'The current agent remains active. A new candidate will be stored in a separate secure slot and no transaction will be submitted.',
            'Create key',
          ))
        ) {
          return;
        }
        const result = await coordinator.createCandidate(owner);
        setMessage(messageFor(result));
        if (result.status === 'candidate_secured') {
          setCandidate(result.candidateAgent);
        }
      }),
    [coordinator, owner, run],
  );

  const fundCandidate = useCallback(
    () =>
      run(async () => {
        if (!candidate) return;
        const result = await service.fundCandidate(
          owner,
          new PublicKey(candidate),
          walletDependencies,
        );
        if (result.status === 'confirmed') {
          setSignature(result.signature);
          setMessage(
            'The replacement agent is funded. Funding did not rotate the vault or count as liveness.',
          );
        } else if (result.status === 'already_funded') {
          setMessage(
            'The replacement agent already meets the recommended reserve.',
          );
        } else if (result.status === 'confirmation_unknown') {
          setSignature(result.signature);
          setMessage(
            'Candidate funding was submitted but is inconclusive. Check the transaction before attempting rotation; no automatic retry will occur.',
          );
        } else if (result.status !== 'owner_cancelled') {
          setMessage(
            'Candidate funding did not complete. The current agent remains active and no rotation occurred.',
          );
        }
      }),
    [
      candidate,
      owner,
      run,
      service,
      walletDependencies,
    ],
  );

  const rotate = useCallback(
    () =>
      run(async () => {
        if (!candidate) return;
        const remaining =
          secondsRemaining === null
            ? 'The deadline will be verified again before signing.'
            : `${secondsRemaining} seconds remain before the final deadline.`;
        if (
          !(await confirmAlert(
            'Authorise agent rotation?',
            `This requires both the replacement device key and your connected owner wallet.\n\n${remaining}\n\nA failed rotation does not extend the protocol deadline.`,
            'Sign rotation',
          ))
        ) {
          return;
        }
        const result = await coordinator.rotate(owner);
        setMessage(messageFor(result));
        if ('signature' in result) setSignature(result.signature);
        if (result.status === 'confirmed') setCandidate(null);
      }),
    [candidate, coordinator, owner, run, secondsRemaining],
  );

  return (
    <View style={styles.card}>
      <Text style={styles.title}>CRASH-SAFE AGENT ROTATION</Text>
      <Text style={styles.message}>{message}</Text>
      {candidate ? (
        <Text style={styles.address}>
          Candidate: {truncateAddress(candidate, 8)}
        </Text>
      ) : null}
      {secondsRemaining !== null ? (
        <Text style={styles.deadline}>
          Verified rotation window: {secondsRemaining}s remaining
        </Text>
      ) : null}
      <View style={styles.actions}>
        <TouchableOpacity
          disabled={busy || candidate !== null}
          onPress={createCandidate}
          style={[
            styles.button,
            (busy || candidate !== null) && styles.disabled,
          ]}
        >
          <Text style={styles.buttonText}>Create candidate</Text>
        </TouchableOpacity>
        <TouchableOpacity
          disabled={busy || !candidate}
          onPress={fundCandidate}
          style={[
            styles.button,
            (busy || !candidate) && styles.disabled,
          ]}
        >
          <Text style={styles.buttonText}>Fund candidate</Text>
        </TouchableOpacity>
        <TouchableOpacity
          disabled={busy || !candidate}
          onPress={rotate}
          style={[
            styles.button,
            styles.primary,
            (busy || !candidate) && styles.disabled,
          ]}
        >
          <Text style={styles.primaryText}>Authorise rotation</Text>
        </TouchableOpacity>
      </View>
      {signature ? (
        <TouchableOpacity
          onPress={() => Linking.openURL(explorerTx(signature))}
        >
          <Text style={styles.link}>View submitted transaction</Text>
        </TouchableOpacity>
      ) : null}
      <Text style={styles.retention}>
        The previous key is retained after confirmation. Cleanup is a
        later explicit gate.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginBottom: 16,
    padding: 16,
    borderRadius: 14,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  title: {
    color: COLORS.textMuted,
    fontFamily: FONTS.primarySemiBold,
    fontSize: 11,
    letterSpacing: 1,
  },
  message: {
    color: COLORS.textSecondary,
    fontFamily: FONTS.primary,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 8,
  },
  address: {
    color: COLORS.textPrimary,
    fontFamily: FONTS.mono,
    fontSize: 12,
    marginTop: 10,
  },
  deadline: {
    color: COLORS.warning,
    fontFamily: FONTS.primaryMedium,
    fontSize: 12,
    marginTop: 8,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 14,
  },
  button: {
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  primary: {
    backgroundColor: COLORS.accent,
    borderColor: COLORS.accent,
  },
  disabled: { opacity: 0.35 },
  buttonText: {
    color: COLORS.textPrimary,
    fontFamily: FONTS.primaryMedium,
    fontSize: 12,
  },
  primaryText: {
    color: COLORS.bg,
    fontFamily: FONTS.primarySemiBold,
    fontSize: 12,
  },
  link: {
    color: COLORS.accent,
    fontFamily: FONTS.primaryMedium,
    fontSize: 12,
    marginTop: 12,
  },
  retention: {
    color: COLORS.textDim,
    fontFamily: FONTS.primary,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 12,
  },
});
