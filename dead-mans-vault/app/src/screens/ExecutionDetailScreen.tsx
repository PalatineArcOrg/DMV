import React from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  Linking,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useRoute } from '@react-navigation/native';
import { COLORS, FONTS } from '../utils/constants';
import { explorerTx } from '../utils/rpcConfig';
import { HistoryStep } from '../services/ExecutionHistoryService';

const TYPE_ICONS: Record<string, string> = {
  begin_execution: 'play-circle-outline',
  begin_token_dist: 'camera-outline',
  execute_specific_asset: 'gift-outline',
  execute_specific_sol: 'gift-outline',
  execute_sol_shares: 'currency-usd',
  execute_token_shares: 'swap-horizontal',
  finalize_execution: 'check-decagram',
  close_token_dist: 'archive-outline',
  close_executed_vault_by_owner: 'archive-check',
};

function openExplorer(signature: string) {
  const url = explorerTx(signature);
  Linking.openURL(url);
}

export function ExecutionDetailScreen() {
  const route = useRoute<any>();
  const { steps, executedAt, totalSolDistributed, tokenTransferCount } = route.params as {
    steps: HistoryStep[];
    executedAt: number;
    totalSolDistributed: number;
    tokenTransferCount: number;
  };

  const solDistributions = steps.filter((s) => (s.solAmount ?? 0) > 0);
  const tokenDistributions = steps.filter((s) => (s.tokenAmount ?? 0) > 0);
  const date = new Date(executedAt * 1000);

  return (
    <FlatList
      style={styles.container}
      data={steps}
      keyExtractor={(item, index) => item.txSignature || `step-${index}`}
      renderItem={({ item, index }) => (
        <StepRow step={item} isLast={index === steps.length - 1} />
      )}
      ListHeaderComponent={
        <View>
          {/* Summary Banner */}
          <View style={styles.banner}>
            <MaterialCommunityIcons name="check-circle" size={24} color={COLORS.accent} />
            <View style={styles.bannerText}>
              <Text style={styles.bannerTitle}>Vault Executed</Text>
              <Text style={styles.bannerDate}>
                {date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                {' at '}
                {date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
              </Text>
            </View>
          </View>

          {/* Stats Row */}
          <View style={styles.statsRow}>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>{totalSolDistributed.toFixed(4)}</Text>
              <Text style={styles.statLabel}>SOL Distributed</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>{solDistributions.length + tokenDistributions.length}</Text>
              <Text style={styles.statLabel}>Transfers</Text>
            </View>
            {tokenTransferCount > 0 && (
              <View style={styles.statCard}>
                <Text style={styles.statValue}>{tokenTransferCount}</Text>
                <Text style={styles.statLabel}>Token TXs</Text>
              </View>
            )}
          </View>

          <View style={styles.sectionHeader}>
            <Text style={styles.sectionLabel}>TRANSACTIONS ({steps.length})</Text>
          </View>
        </View>
      }
      contentContainerStyle={styles.listContent}
      ListFooterComponent={<View style={{ height: 24 }} />}
    />
  );
}

function StepRow({ step, isLast }: { step: HistoryStep; isLast: boolean }) {
  const iconName = (TYPE_ICONS[step.type] || 'circle-outline') as any;
  const time = new Date(step.timestamp * 1000);

  return (
    <View style={[styles.stepCard, !isLast && styles.stepCardMargin]}>
      <View style={styles.timelineCol}>
        <View style={[styles.timelineDot, { backgroundColor: COLORS.accent }]} />
        {!isLast && <View style={styles.timelineLine} />}
      </View>

      <View style={styles.stepContent}>
        <View style={styles.stepHeader}>
          <MaterialCommunityIcons name={iconName} size={14} color={COLORS.accent} />
          <Text style={styles.stepType}>{step.type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}</Text>
        </View>

        <Text style={styles.stepDescription}>{step.description}</Text>

        {step.txSignature ? (
          <TouchableOpacity style={styles.txRow} onPress={() => openExplorer(step.txSignature)}>
            <MaterialCommunityIcons name="open-in-new" size={10} color={COLORS.accent} />
            <Text style={styles.txSignature}>
              {step.txSignature.slice(0, 8)}...{step.txSignature.slice(-8)}
            </Text>
            <Text style={styles.explorerHint}>Explorer</Text>
          </TouchableOpacity>
        ) : null}

        {step.timestamp > 0 ? (
          <Text style={styles.timestampText}>
            {time.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </Text>
        ) : null}
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
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 16,
    borderRadius: 16,
    backgroundColor: 'rgba(0,255,163,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(0,255,163,0.2)',
    marginTop: 8,
    marginBottom: 16,
  },
  bannerText: {
    flex: 1,
  },
  bannerTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.accent,
    fontFamily: FONTS.primaryBold,
  },
  bannerDate: {
    fontSize: 12,
    color: 'rgba(0,255,163,0.5)',
    fontFamily: FONTS.primary,
    marginTop: 1,
  },
  statsRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 16,
  },
  statCard: {
    flex: 1,
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    padding: 12,
    alignItems: 'center',
  },
  statValue: {
    fontSize: 16,
    fontWeight: '700',
    color: '#FFFFFF',
    fontFamily: FONTS.primaryBold,
  },
  statLabel: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.4)',
    fontFamily: FONTS.primary,
    marginTop: 2,
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
    paddingVertical: 6,
  },
  stepCardMargin: {},
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
    gap: 6,
    marginBottom: 6,
  },
  stepType: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.5)',
    fontFamily: FONTS.primary,
    textTransform: 'uppercase',
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
    flex: 1,
  },
  explorerHint: {
    fontSize: 9,
    color: 'rgba(0,255,163,0.4)',
    fontFamily: FONTS.primary,
  },
  timestampText: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.25)',
    fontFamily: FONTS.mono,
    marginTop: 6,
  },
});
