import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  RefreshControl,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { COLORS, FONTS } from '../utils/constants';
import { useWallet } from '../hooks/useWallet';
import { getExecutionHistory, ExecutionSummary } from '../services/ExecutionHistoryService';
import { getExecutionSteps } from '../db/executionRepo';

const STEP_TYPE_MAP: Record<string, string> = {
  revoke_approvals: 'RevokeApprovals',
  close_defi_position: 'CloseDeFiPosition',
  distribute_specific_asset: 'DistributeSpecificAsset',
  distribute_sol: 'ExecuteSolDistribution',
  distribute_token: 'ExecuteDistribution',
  burn_asset: 'BurnAsset',
  close_accounts: 'CloseAccounts',
  record_execution_log: 'RecordExecution',
  close_executed_vault: 'CloseExecutedVault',
  refund_agent_sol: 'RefundAgentSol',
  self_terminate: 'SelfTerminate',
};

export function ExecutionLogsScreen() {
  const { publicKey } = useWallet();
  const navigation = useNavigation<any>();
  const [executions, setExecutions] = useState<ExecutionSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const loadHistory = useCallback(async () => {
    if (!publicKey) return;
    setIsLoading(true);
    try {
      // Fetch from Helius on-chain history
      const history = await getExecutionHistory(publicKey);

      // If no on-chain history found, fall back to local SQLite
      if (history.length === 0) {
        const localSteps = await getExecutionSteps(publicKey.toString());
        const visible = localSteps.filter((s) => s.status !== 'skipped');
        if (visible.length > 0) {
          // Build a single execution summary from local data
          const completed = visible.filter((s) => s.status === 'completed');
          const recordStep = visible.find((s) => s.type === 'record_execution_log');
          const solSteps = completed.filter((s) => s.type === 'distribute_sol');
          const tokenSteps = completed.filter((s) => s.type === 'distribute_token');

          const localExec: ExecutionSummary = {
            executedAt: recordStep?.completedAt ?? Math.floor(Date.now() / 1000),
            recordTxSignature: recordStep?.txSignature ?? '',
            steps: visible.map((s) => ({
              type: STEP_TYPE_MAP[s.type] || s.type,
              txSignature: s.txSignature ?? '',
              timestamp: s.completedAt ?? s.startedAt ?? 0,
              description: s.description,
            })),
            totalSolDistributed: 0,
            tokenTransferCount: tokenSteps.length,
          };
          setExecutions([localExec]);
          return;
        }
      }

      setExecutions(history);
    } catch {
      // Non-fatal
    } finally {
      setIsLoading(false);
    }
  }, [publicKey]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  if (!isLoading && executions.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <View style={styles.emptyIcon}>
          <MaterialCommunityIcons name="text-box-outline" size={40} color="rgba(255,255,255,0.15)" />
        </View>
        <Text style={styles.emptyTitle}>No Executions</Text>
        <Text style={styles.emptyDescription}>
          When your estate plan executes, a detailed log of every transaction will appear here.
        </Text>
      </View>
    );
  }

  if (isLoading && executions.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <ActivityIndicator size="large" color={COLORS.accent} />
        <Text style={[styles.emptyDescription, { marginTop: 16 }]}>Loading execution history...</Text>
      </View>
    );
  }

  return (
    <FlatList
      style={styles.container}
      data={executions}
      keyExtractor={(item, index) => item.recordTxSignature || `exec-${item.executedAt}-${index}`}
      refreshControl={
        <RefreshControl
          refreshing={isLoading}
          onRefresh={loadHistory}
          tintColor={COLORS.accent}
        />
      }
      renderItem={({ item }) => (
        <ExecutionCard
          execution={item}
          onPress={() =>
            navigation.navigate('ExecutionDetail', {
              steps: item.steps,
              executedAt: item.executedAt,
              totalSolDistributed: item.totalSolDistributed,
              tokenTransferCount: item.tokenTransferCount,
            })
          }
        />
      )}
      ListHeaderComponent={
        <View style={styles.headerRow}>
          <MaterialCommunityIcons name="history" size={16} color="rgba(255,255,255,0.4)" />
          <Text style={styles.headerLabel}>
            {executions.length} EXECUTION{executions.length !== 1 ? 'S' : ''}
          </Text>
        </View>
      }
      contentContainerStyle={styles.listContent}
      ListFooterComponent={<View style={{ height: 24 }} />}
    />
  );
}

function ExecutionCard({
  execution,
  onPress,
}: {
  execution: ExecutionSummary;
  onPress: () => void;
}) {
  const date = new Date(execution.executedAt * 1000);
  const transferCount = execution.steps.filter(
    (s) => s.type === 'ExecuteSolDistribution' || s.type === 'ExecuteDistribution',
  ).length;

  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.cardLeft}>
        <View style={styles.cardIcon}>
          <MaterialCommunityIcons name="check-circle" size={20} color={COLORS.accent} />
        </View>
        <View style={styles.cardInfo}>
          <Text style={styles.cardTitle}>Vault Executed</Text>
          <Text style={styles.cardDate}>
            {date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
            {' at '}
            {date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
          </Text>
          <Text style={styles.cardStats}>
            {transferCount} transfer{transferCount !== 1 ? 's' : ''}
            {execution.totalSolDistributed > 0 ? ` · ${execution.totalSolDistributed.toFixed(4)} SOL` : ''}
            {execution.tokenTransferCount > 0 ? ` · ${execution.tokenTransferCount} token TX${execution.tokenTransferCount !== 1 ? 's' : ''}` : ''}
          </Text>
        </View>
      </View>
      <MaterialCommunityIcons name="chevron-right" size={18} color="rgba(255,255,255,0.3)" />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  emptyContainer: {
    flex: 1,
    backgroundColor: COLORS.bg,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  emptyIcon: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#FFFFFF',
    fontFamily: FONTS.primaryBold,
    marginBottom: 8,
  },
  emptyDescription: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.4)',
    fontFamily: FONTS.primary,
    textAlign: 'center',
    lineHeight: 20,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 12,
    marginTop: 4,
  },
  headerLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.4)',
    letterSpacing: 1,
    fontFamily: FONTS.primarySemiBold,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    borderRadius: 16,
    padding: 16,
    marginBottom: 10,
  },
  cardLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 12,
  },
  cardIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,255,163,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardInfo: {
    flex: 1,
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#FFFFFF',
    fontFamily: FONTS.primaryBold,
  },
  cardDate: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.5)',
    fontFamily: FONTS.primary,
    marginTop: 2,
  },
  cardStats: {
    fontSize: 11,
    color: COLORS.accent,
    fontFamily: FONTS.primary,
    marginTop: 3,
  },
});
