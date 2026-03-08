import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  RefreshControl,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { getExecutionSteps } from '../db/executionRepo';
import { ExecutionStep, ExecutionStepStatus } from '../types/execution';
import { truncateAddress, formatTimestamp } from '../utils/formatting';
import { COLORS, FONTS } from '../utils/constants';
import { useWallet } from '../hooks/useWallet';

const STATUS_COLORS: Record<ExecutionStepStatus, string> = {
  completed: COLORS.healthy,
  failed: COLORS.critical,
  in_progress: COLORS.warning,
  skipped: COLORS.textMuted,
  pending: COLORS.border,
};

const STATUS_ICONS: Record<ExecutionStepStatus, string> = {
  completed: 'check-circle',
  failed: 'close-circle',
  in_progress: 'progress-clock',
  skipped: 'skip-next-circle',
  pending: 'circle-outline',
};

export function ExecutionLogScreen() {
  const { publicKey } = useWallet();
  const [steps, setSteps] = useState<ExecutionStep[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const loadSteps = useCallback(async () => {
    setIsLoading(true);
    try {
      const ownerWallet = publicKey?.toString();
      const data = await getExecutionSteps(ownerWallet);
      setSteps(data);
    } catch {
      // Non-fatal
    } finally {
      setIsLoading(false);
    }
  }, [publicKey]);

  useEffect(() => {
    loadSteps();
  }, [loadSteps]);

  // Filter out skipped MVP placeholder steps — they did no real work
  const visibleSteps = steps.filter((s) => s.status !== 'skipped');
  const completedSteps = visibleSteps.filter((s) => s.status === 'completed');
  const failedSteps = visibleSteps.filter((s) => s.status === 'failed');

  if (!isLoading && visibleSteps.length === 0) {
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

  return (
    <FlatList
      style={styles.container}
      data={visibleSteps}
      keyExtractor={(item) => item.id}
      refreshControl={
        <RefreshControl
          refreshing={isLoading}
          onRefresh={loadSteps}
          tintColor={COLORS.accent}
        />
      }
      renderItem={({ item, index }) => (
        <StepCard step={item} isLast={index === visibleSteps.length - 1} />
      )}
      ListHeaderComponent={
        <View>
          {/* Status Banner */}
          {visibleSteps.length > 0 && (
            <View style={[styles.statusBanner, failedSteps.length > 0 ? styles.statusBannerError : styles.statusBannerSuccess]}>
              <MaterialCommunityIcons
                name={failedSteps.length > 0 ? 'alert-octagon' : 'check-circle'}
                size={24}
                color={failedSteps.length > 0 ? '#DC2626' : COLORS.accent}
              />
              <View style={styles.statusBannerText}>
                <Text style={[styles.statusBannerTitle, { color: failedSteps.length > 0 ? '#DC2626' : COLORS.accent }]}>
                  {failedSteps.length > 0 ? 'Execution Errors' : 'Vault Executed'}
                </Text>
                <Text style={[styles.statusBannerSub, { color: failedSteps.length > 0 ? 'rgba(220,38,38,0.6)' : 'rgba(0,255,163,0.5)' }]}>
                  {failedSteps.length > 0
                    ? `${failedSteps.length} step(s) failed`
                    : `${completedSteps.length} steps completed`}
                </Text>
              </View>
            </View>
          )}

          {/* Section Label */}
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionLabel}>TRANSACTIONS ({visibleSteps.length})</Text>
          </View>
        </View>
      }
      contentContainerStyle={styles.listContent}
      ListFooterComponent={<View style={{ height: 24 }} />}
    />
  );
}

function StepCard({ step, isLast }: { step: ExecutionStep; isLast: boolean }) {
  const displayStatus = step.status.toUpperCase();
  const statusColor = STATUS_COLORS[step.status];
  const statusIcon = STATUS_ICONS[step.status] as any;

  return (
    <View style={[styles.stepCard, !isLast && styles.stepCardBorder]}>
      {/* Timeline dot */}
      <View style={styles.timelineCol}>
        <View style={[styles.timelineDot, { backgroundColor: statusColor }]} />
        {!isLast && <View style={styles.timelineLine} />}
      </View>

      {/* Content */}
      <View style={styles.stepContent}>
        <View style={styles.stepHeader}>
          <View style={[styles.statusPill, { backgroundColor: statusColor + '15', borderColor: statusColor + '30' }]}>
            <MaterialCommunityIcons name={statusIcon} size={10} color={statusColor} />
            <Text style={[styles.statusPillText, { color: statusColor }]}>{displayStatus}</Text>
          </View>
          <Text style={styles.stepType}>{step.type.replace(/_/g, ' ')}</Text>
        </View>

        <Text style={styles.stepDescription}>{step.description}</Text>

        {step.txSignature && (
          <View style={styles.txRow}>
            <MaterialCommunityIcons name="link-variant" size={10} color={COLORS.accent} />
            <Text style={styles.txSignature}>{truncateAddress(step.txSignature, 8)}</Text>
          </View>
        )}

        {step.error && (
          <View style={styles.errorRow}>
            <MaterialCommunityIcons name="alert-circle-outline" size={10} color={COLORS.critical} />
            <Text style={styles.errorText} numberOfLines={2}>{step.error}</Text>
          </View>
        )}

        <View style={styles.timestamps}>
          {step.startedAt && (
            <Text style={styles.timestampText}>{formatTimestamp(step.startedAt)}</Text>
          )}
        </View>
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
    paddingHorizontal: 16,
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
  statusBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 16,
    borderRadius: 16,
    marginBottom: 16,
    marginTop: 8,
  },
  statusBannerSuccess: {
    backgroundColor: 'rgba(0,255,163,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(0,255,163,0.2)',
  },
  statusBannerError: {
    backgroundColor: 'rgba(220,38,38,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(220,38,38,0.3)',
  },
  statusBannerText: {
    flex: 1,
  },
  statusBannerTitle: {
    fontSize: 15,
    fontWeight: '700',
    fontFamily: FONTS.primaryBold,
  },
  statusBannerSub: {
    fontSize: 12,
    fontFamily: FONTS.primary,
    marginTop: 1,
  },
  sectionHeader: {
    marginBottom: 12,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.4)',
    letterSpacing: 1,
    fontFamily: FONTS.primarySemiBold,
  },
  stepCard: {
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 12,
  },
  stepCardBorder: {
    // No explicit border — the timeline line handles visual connection
  },
  timelineCol: {
    alignItems: 'center',
    width: 16,
    paddingTop: 2,
  },
  timelineDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  timelineLine: {
    width: 1,
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.08)',
    marginTop: 4,
  },
  stepContent: {
    flex: 1,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    borderRadius: 14,
    padding: 14,
  },
  stepHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
  },
  statusPillText: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.5,
    fontFamily: FONTS.primaryBold,
  },
  stepType: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.4)',
    textTransform: 'uppercase',
    fontFamily: FONTS.primary,
  },
  stepDescription: {
    fontSize: 13,
    color: '#FFFFFF',
    fontFamily: FONTS.primary,
    lineHeight: 18,
    marginBottom: 6,
  },
  txRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
  },
  txSignature: {
    fontSize: 11,
    color: COLORS.accent,
    fontFamily: FONTS.mono,
  },
  errorRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 4,
    marginTop: 6,
    backgroundColor: 'rgba(239,68,68,0.06)',
    borderRadius: 8,
    padding: 8,
  },
  errorText: {
    fontSize: 11,
    color: COLORS.critical,
    fontFamily: FONTS.primary,
    flex: 1,
    lineHeight: 16,
  },
  timestamps: {
    marginTop: 8,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.05)',
    paddingTop: 6,
  },
  timestampText: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.25)',
    fontFamily: FONTS.mono,
  },
});
