import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  Alert,
  AppState,
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
import type { AgentFeeReadinessResult } from '../services/AgentFeeReadinessService';
import {
  createAgentTopUpService,
  type AgentTopUpConfirmation,
} from '../services/AgentTopUpService';
import { createDefaultAgentReadinessService } from '../services/DefaultAgentReadinessService';
import { VaultTransactionService } from '../services/VaultTransactionService';
import { KeyManager } from '../tee/KeyManager';
import {
  COLORS,
  EXPECTED_CLUSTER,
  FONTS,
  PROGRAM_ID,
} from '../utils/constants';
import { explorerTx } from '../utils/rpcConfig';
import { assertNetworkVerified } from '../store/useNetworkStore';
import { truncateAddress } from '../utils/formatting';

type DisplayFeeState =
  | AgentFeeReadinessResult
  | {
      status:
        | 'checking'
        | 'agent_missing'
        | 'agent_mismatch'
        | 'vault_unavailable';
    };

interface AgentFeeCardProps {
  owner: PublicKey | null;
  refreshKey?: string | null;
}

interface AgentFeeSnapshot {
  state: DisplayFeeState;
  agent: PublicKey | null;
  refreshedAt: number;
}

const agentFeeRefreshes = new Map<
  string,
  Promise<AgentFeeSnapshot>
>();

async function readAgentFeeSnapshot(
  owner: PublicKey,
): Promise<AgentFeeSnapshot> {
  try {
    const storedAgent =
      await KeyManager.getInstance().getAgentPublicKey();
    if (!storedAgent) {
      return {
        state: { status: 'agent_missing' },
        agent: null,
        refreshedAt: Date.now(),
      };
    }
    const localAgent = new PublicKey(storedAgent);
    const transactions = new VaultTransactionService();
    const vault = await transactions.fetchVaultConfig(owner);
    if (!vault || !vault.active || vault.executed) {
      return {
        state: { status: 'vault_unavailable' },
        agent: null,
        refreshedAt: Date.now(),
      };
    }
    if (!vault.agentPubkey.equals(localAgent)) {
      return {
        state: { status: 'agent_mismatch' },
        agent: localAgent,
        refreshedAt: Date.now(),
      };
    }
    const prepared =
      await transactions.prepareHeartbeatTransaction(
        localAgent,
        owner,
        'active_tap',
      );
    return {
      state:
        prepared.status === 'prepared'
          ? prepared.prepared.feeReadiness
          : prepared.status === 'insufficient'
            ? prepared
            : {
                status: 'check_unavailable',
                reason: 'fee_unavailable',
              },
      agent: localAgent,
      refreshedAt: Date.now(),
    };
  } catch {
    return {
      state: {
        status: 'check_unavailable',
        reason: 'balance_unavailable',
      },
      agent: null,
      refreshedAt: Date.now(),
    };
  }
}

function refreshAgentFeeSnapshot(
  owner: PublicKey,
): Promise<AgentFeeSnapshot> {
  const identity =
    `${EXPECTED_CLUSTER}:${PROGRAM_ID}:${owner.toBase58()}`;
  const existing = agentFeeRefreshes.get(identity);
  if (existing) return existing;
  const refresh = readAgentFeeSnapshot(owner).finally(() => {
    agentFeeRefreshes.delete(identity);
  });
  agentFeeRefreshes.set(identity, refresh);
  return refresh;
}

function formatSol(lamports: number): string {
  return `${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`;
}

function cancellationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('cancel') ||
    message.includes('declin') ||
    message.includes('reject')
  );
}

function requestTopUpConfirmation(
  confirmation: AgentTopUpConfirmation,
): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      'Top up heartbeat agent?',
      `Transfer: ${formatSol(confirmation.transferLamports)}\n` +
        `Owner network fee: ${formatSol(confirmation.ownerFeeLamports)}\n\n` +
        `Destination: ${truncateAddress(confirmation.agent.toBase58(), 6)}`,
      [
        {
          text: 'Cancel',
          style: 'cancel',
          onPress: () => resolve(false),
        },
        {
          text: 'Sign transfer',
          onPress: () => resolve(true),
        },
      ],
      { cancelable: false },
    );
  });
}

export function AgentFeeCard({
  owner,
  refreshKey = null,
}: AgentFeeCardProps) {
  const { signTransaction } = useWallet();
  const [feeState, setFeeState] = useState<DisplayFeeState>({
    status: 'checking',
  });
  const [agent, setAgent] = useState<PublicKey | null>(null);
  const [isStale, setIsStale] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);
  const [topUpBusy, setTopUpBusy] = useState(false);
  const [topUpSignature, setTopUpSignature] =
    useState<string | null>(null);
  const identityGeneration = useRef(0);

  const refresh = useCallback(async () => {
    if (!owner) return;
    const ownerIdentity = owner.toBase58();
    const generation = ++identityGeneration.current;
    setFeeState({ status: 'checking' });
    const snapshot = await refreshAgentFeeSnapshot(owner);
    if (
      generation !== identityGeneration.current ||
      ownerIdentity !== owner.toBase58()
    ) {
      return;
    }
    setAgent(snapshot.agent);
    setFeeState(snapshot.state);
    setLastRefresh(snapshot.refreshedAt);
    setIsStale(false);
  }, [owner]);

  useEffect(() => {
    identityGeneration.current += 1;
    setIsStale(true);
    setAgent(null);
    if (owner) void refresh();
  }, [owner, refresh]);

  useEffect(() => {
    if (refreshKey && owner) void refresh();
  }, [owner, refresh, refreshKey]);

  useFocusEffect(
    useCallback(() => {
      if (owner) void refresh();
      return () => {
        identityGeneration.current += 1;
        setIsStale(true);
      };
    }, [owner, refresh]),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener(
      'change',
      (nextState) => {
        if (nextState === 'active') {
          if (owner) void refresh();
        } else {
          setIsStale(true);
        }
      },
    );
    return () => subscription.remove();
  }, [owner, refresh]);

  const handleTopUp = useCallback(async () => {
    if (!owner || !agent || topUpBusy) return;
    setTopUpBusy(true);
    setTopUpSignature(null);
    try {
      const transactions = new VaultTransactionService();
      const connection = transactions.getConnection();
      const service = createAgentTopUpService({
        checkAgentReadiness: (currentOwner) =>
          createDefaultAgentReadinessService().check(currentOwner),
        assertNetworkVerified: () =>
          assertNetworkVerified('Heartbeat-agent top-up'),
        getBalance: (address, minimumContextSlot) =>
          connection.getBalanceAndContext(address, {
            commitment: 'confirmed',
            ...(minimumContextSlot === undefined
              ? {}
              : { minContextSlot: minimumContextSlot }),
          }),
        getLatestBlockhash: () =>
          connection.getLatestBlockhash('confirmed'),
        getFeeForMessage: (transaction) =>
          connection.getFeeForMessage(
            transaction.compileMessage(),
            'confirmed',
          ),
        confirmTransfer: requestTopUpConfirmation,
        signTransaction: async (transaction) => {
          const signed = await signTransaction(transaction);
          if (!(signed instanceof Transaction)) {
            throw new Error('Wallet returned an unexpected transaction type');
          }
          return signed;
        },
        sendRawTransaction: (serializedTransaction) =>
          connection.sendRawTransaction(serializedTransaction, {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
          }),
        confirmTransaction: (strategy) =>
          connection.confirmTransaction(strategy, 'confirmed'),
        isOwnerCancellation: cancellationError,
      });
      const result = await service.topUp(owner, agent);
      if (result.status === 'confirmed') {
        setTopUpSignature(result.signature);
        Alert.alert(
          'Agent funded',
          `Transferred ${formatSol(result.transferredLamports)} to the authorised heartbeat agent.`,
        );
        await refresh();
      } else if (result.status === 'already_funded') {
        Alert.alert(
          'Agent funded',
          'The heartbeat agent already meets the recommended reserve.',
        );
        await refresh();
      } else if (result.status === 'owner_cancelled') {
        return;
      } else if (result.status === 'owner_insufficient_funds') {
        Alert.alert(
          'Owner balance too low',
          `This transfer and its network fee require ${formatSol(result.requiredLamports)}.`,
        );
      } else if (result.status === 'confirmation_unknown') {
        setTopUpSignature(result.signature);
        Alert.alert(
          'Top-up result unknown',
          'The transfer was submitted, but confirmation was inconclusive. Do not submit another top-up until you check the transaction.',
        );
      } else if (result.status === 'transaction_failed') {
        setTopUpSignature(result.signature);
        Alert.alert(
          'Top-up failed',
          'The owner-signed transfer was confirmed as failed.',
        );
      } else if (result.status === 'destination_changed') {
        Alert.alert(
          'Agent changed',
          'The authorised heartbeat agent changed. No transfer was sent.',
        );
      } else if (result.status === 'precondition_failed') {
        Alert.alert(
          'Top-up unavailable',
          'The canonical active vault and its authorised device agent could not be verified. No transfer was sent.',
        );
      } else {
        Alert.alert(
          'Top-up not submitted',
          'The owner-signed transfer could not be prepared or submitted.',
        );
      }
    } finally {
      setTopUpBusy(false);
    }
  }, [agent, owner, refresh, signTransaction, topUpBusy]);

  const hasAmounts =
    feeState.status === 'ready' ||
    feeState.status === 'low_reserve' ||
    feeState.status === 'insufficient';
  const canTopUp =
    !isStale &&
    (feeState.status === 'low_reserve' ||
      feeState.status === 'insufficient');

  const statusText =
    isStale
      ? 'Agent fee state is stale. Refreshing…'
      : feeState.status === 'ready'
        ? 'Heartbeat agent funded'
        : feeState.status === 'low_reserve'
          ? 'The agent can pay for this heartbeat, but its SOL reserve is running low.'
          : feeState.status === 'insufficient'
            ? 'The heartbeat agent does not have enough SOL to submit a heartbeat. No heartbeat transaction was sent.'
            : feeState.status === 'check_unavailable' ||
                feeState.status === 'invalid_response'
              ? 'The agent fee balance could not be verified. You may still submit a deliberate heartbeat; Solana will enforce the actual fee requirement.'
              : feeState.status === 'agent_missing'
                ? 'This device has no authorised heartbeat agent key.'
                : feeState.status === 'agent_mismatch'
                  ? 'This device’s key does not match the authorised onchain agent.'
                  : feeState.status === 'vault_unavailable'
                    ? 'No active heartbeat vault is available.'
                    : 'Checking heartbeat agent funding…';

  return (
    <View style={styles.card}>
      <Text style={styles.title}>HEARTBEAT AGENT FEES</Text>
      <Text style={styles.status}>{statusText}</Text>
      {agent ? (
        <Text style={styles.detail}>
          Agent: {truncateAddress(agent.toBase58(), 6)}
        </Text>
      ) : null}
      {hasAmounts ? (
        <>
          <Text style={styles.detail}>
            Balance: {formatSol(feeState.balanceLamports)}
          </Text>
          <Text style={styles.detail}>
            Estimated heartbeat fee: {formatSol(feeState.feeLamports)}
          </Text>
          <Text style={styles.detail}>
            Recommended reserve:{' '}
            {formatSol(feeState.reserveTargetLamports)}
          </Text>
          {'estimatedHeartbeatsRemaining' in feeState ? (
            <Text style={styles.detail}>
              Approx. heartbeats remaining:{' '}
              {feeState.estimatedHeartbeatsRemaining}
            </Text>
          ) : (
            <Text style={styles.detail}>
              Shortfall: {formatSol(feeState.shortfallLamports)}
            </Text>
          )}
        </>
      ) : null}
      <Text style={styles.refreshed}>
        {isStale
          ? 'Stale'
          : lastRefresh
            ? `Last refreshed ${new Date(lastRefresh).toLocaleTimeString()}`
            : 'Not yet refreshed'}
      </Text>
      {canTopUp ? (
        <TouchableOpacity
          style={styles.button}
          disabled={topUpBusy}
          onPress={handleTopUp}
        >
          <Text style={styles.buttonText}>
            {topUpBusy ? 'Preparing top-up…' : 'Top up authorised agent'}
          </Text>
        </TouchableOpacity>
      ) : null}
      {topUpSignature ? (
        <TouchableOpacity
          onPress={() => Linking.openURL(explorerTx(topUpSignature))}
        >
          <Text style={styles.link}>View top-up transaction</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginTop: 12,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
  },
  title: {
    color: COLORS.textMuted,
    fontFamily: FONTS.primarySemiBold,
    fontSize: 11,
    letterSpacing: 1,
  },
  status: {
    color: COLORS.textPrimary,
    fontFamily: FONTS.primaryMedium,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 8,
  },
  detail: {
    color: COLORS.textSecondary,
    fontFamily: FONTS.mono,
    fontSize: 11,
    marginTop: 5,
  },
  refreshed: {
    color: COLORS.textMuted,
    fontFamily: FONTS.primary,
    fontSize: 10,
    marginTop: 8,
  },
  button: {
    marginTop: 12,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
    backgroundColor: COLORS.accent,
  },
  buttonText: {
    color: COLORS.bg,
    fontFamily: FONTS.primarySemiBold,
    fontSize: 12,
  },
  link: {
    color: COLORS.accent,
    fontFamily: FONTS.primaryMedium,
    fontSize: 11,
    textAlign: 'center',
    marginTop: 10,
  },
});
