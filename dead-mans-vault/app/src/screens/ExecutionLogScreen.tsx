import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  RefreshControl,
} from 'react-native';
import { getExecutionSteps } from '../db/executionRepo';
import { ExecutionStep, ExecutionStepStatus } from '../types/execution';
import { truncateAddress, formatTimestamp } from '../utils/formatting';
import { COLORS, SPACING, FONTS } from '../utils/constants';

const STATUS_COLORS: Record<ExecutionStepStatus, string> = {
  completed: COLORS.healthy,
  failed: COLORS.critical,
  in_progress: COLORS.warning,
  skipped: COLORS.textMuted,
  pending: COLORS.border,
};

export function ExecutionLogScreen() {
  const [steps, setSteps] = useState<ExecutionStep[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const loadSteps = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await getExecutionSteps();
      setSteps(data);
    } catch {
      // Non-fatal
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSteps();
  }, [loadSteps]);

  if (!isLoading && steps.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.title}>Execution Log</Text>
        <Text style={styles.subtitle}>No executions recorded</Text>
        <Text style={styles.emptyDescription}>
          When your estate plan executes, a detailed log of every transaction will
          appear here.
        </Text>
      </View>
    );
  }

  return (
    <FlatList
      style={styles.container}
      data={steps}
      keyExtractor={(item) => item.id}
      refreshControl={
        <RefreshControl
          refreshing={isLoading}
          onRefresh={loadSteps}
          tintColor={COLORS.accent}
        />
      }
      renderItem={({ item }) => <StepCard step={item} />}
      ListHeaderComponent={
        <Text style={styles.listHeader}>Execution Steps</Text>
      }
      contentContainerStyle={styles.listContent}
    />
  );
}

function StepCard({ step }: { step: ExecutionStep }) {
  const statusColor = STATUS_COLORS[step.status];

  return (
    <View style={styles.stepCard}>
      <View style={styles.stepHeader}>
        <View style={[styles.statusBadge, { backgroundColor: statusColor }]}>
          <Text style={styles.statusText}>{step.status.toUpperCase()}</Text>
        </View>
        <Text style={styles.stepType}>{step.type.replace(/_/g, ' ')}</Text>
      </View>

      <Text style={styles.stepDescription}>{step.description}</Text>

      {step.txSignature && (
        <Text style={styles.txSignature}>
          Tx: {truncateAddress(step.txSignature, 8)}
        </Text>
      )}

      {step.error && (
        <Text style={styles.errorText}>{step.error}</Text>
      )}

      <View style={styles.timestamps}>
        {step.startedAt && (
          <Text style={styles.timestampText}>
            Started: {formatTimestamp(step.startedAt)}
          </Text>
        )}
        {step.completedAt && (
          <Text style={styles.timestampText}>
            Completed: {formatTimestamp(step.completedAt)}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  listContent: {
    padding: SPACING.md,
  },
  listHeader: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.textPrimary,
    marginBottom: SPACING.md,
  },
  emptyContainer: {
    flex: 1,
    backgroundColor: COLORS.bg,
    justifyContent: 'center',
    alignItems: 'center',
    padding: SPACING.xl,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: COLORS.textPrimary,
    marginBottom: SPACING.sm,
  },
  subtitle: {
    fontSize: 16,
    color: COLORS.textSecondary,
    marginBottom: SPACING.md,
  },
  emptyDescription: {
    fontSize: 14,
    color: COLORS.textMuted,
    textAlign: 'center',
    lineHeight: 22,
  },
  stepCard: {
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    padding: SPACING.md,
    marginBottom: SPACING.sm,
  },
  stepHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: SPACING.sm,
  },
  statusBadge: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: 2,
    borderRadius: 4,
    marginRight: SPACING.sm,
  },
  statusText: {
    fontSize: 10,
    fontWeight: '700',
    color: COLORS.textPrimary,
  },
  stepType: {
    fontSize: 12,
    color: COLORS.textSecondary,
    textTransform: 'uppercase',
  },
  stepDescription: {
    fontSize: 14,
    color: COLORS.textPrimary,
    marginBottom: SPACING.xs,
  },
  txSignature: {
    fontSize: 12,
    color: COLORS.accent,
    marginTop: SPACING.xs,
    fontFamily: FONTS.mono,
  },
  errorText: {
    fontSize: 12,
    color: COLORS.critical,
    marginTop: SPACING.xs,
  },
  timestamps: {
    marginTop: SPACING.sm,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    paddingTop: SPACING.xs,
  },
  timestampText: {
    fontSize: 11,
    color: COLORS.textMuted,
    fontFamily: FONTS.mono,
  },
});
