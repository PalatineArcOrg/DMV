import React, { useEffect, useCallback, useRef } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity } from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useWallet } from '../hooks/useWallet';
import { useVaultStore } from '../store/useVaultStore';
import { useHeartbeatStore } from '../store/useHeartbeatStore';
import { useEscalationStore } from '../store/useEscalationStore';
import { validateBeneficiaryShares } from '../utils/validation';
import { truncateAddress, formatDuration } from '../utils/formatting';
import { COLORS, FONTS, SPACING, PROGRAM_ID, STAGE_CONFIG } from '../utils/constants';

export function SetupWizardScreen() {
  const navigation = useNavigation<any>();
  const { publicKey } = useWallet();
  const { beneficiaries, isSetupComplete, setSetupComplete, setVaultConfig, vaultConfig } = useVaultStore();
  const heartbeatConfig = useHeartbeatStore((s) => s.config);
  const escalationStage = useEscalationStore((s) => s.state.stage);

  // Track if we just came from a revoke to prevent auto-sync from refetching stale data
  const wasSetupComplete = useRef(isSetupComplete);
  const skipNextSync = useRef(false);

  useEffect(() => {
    // If isSetupComplete just transitioned from true → false, skip the next auto-sync
    if (wasSetupComplete.current && !isSetupComplete) {
      skipNextSync.current = true;
    }
    wasSetupComplete.current = isSetupComplete;
  }, [isSetupComplete]);

  const heartbeatDone = heartbeatConfig !== null;
  const beneficiariesDone = validateBeneficiaryShares(
    beneficiaries.map((b) => b.shareBps),
  );
  const hasPartialState = beneficiaries.length > 0 || heartbeatDone;

  const handleStartOver = useCallback(() => {
    skipNextSync.current = true;
    useVaultStore.getState().reset();
    useHeartbeatStore.getState().reset();
    useEscalationStore.getState().reset();
  }, []);

  // Reset Setup stack to wizard root when user tabs back (prevents stale screens)
  useFocusEffect(
    useCallback(() => {
      if (!isSetupComplete) {
        navigation.popToTop();
      }
    }, [isSetupComplete, navigation]),
  );

  // Auto-sync: check if on-chain vault exists for connected wallet
  useEffect(() => {
    if (!isSetupComplete && publicKey) {
      // Skip auto-sync if we just revoked — prevents refetching stale data
      if (skipNextSync.current || useVaultStore.getState().isRevoked) {
        skipNextSync.current = false;
        return;
      }
      (async () => {
        try {
          const { VaultTransactionService } = require('../services/VaultTransactionService');
          const txService = new VaultTransactionService();
          const vault = await txService.fetchVaultConfig(publicKey);
          if (vault && vault.active) {
            setVaultConfig(vault);
          }
        } catch {
          // Non-fatal
        }
      })();
    }
  }, [publicKey, isSetupComplete]);

  if (isSetupComplete) {
    const stageCfg = STAGE_CONFIG[escalationStage] ?? STAGE_CONFIG[0];
    const gracePeriod = heartbeatConfig
      ? Math.round(heartbeatConfig.intervalSeconds * 3)
      : 0;

    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* Vault Status Header */}
        <View style={styles.statusHeader}>
          <View style={[styles.statusDot, { backgroundColor: stageCfg.color }]} />
          <Text style={[styles.statusLabel, { color: stageCfg.color }]}>{stageCfg.label}</Text>
          <Text style={styles.statusStageBadge}>{'\u00B7'} Stage {escalationStage}</Text>
        </View>

        {/* Beneficiaries Section */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <MaterialCommunityIcons name="account-group" size={14} color="rgba(255,255,255,0.4)" />
            <Text style={styles.sectionLabel}>BENEFICIARIES</Text>
          </View>
          {beneficiaries.length === 0 ? (
            <View style={styles.sectionRow}>
              <Text style={styles.warningText}>No beneficiaries configured</Text>
            </View>
          ) : (
            beneficiaries.map((b, i) => (
              <View key={i} style={[styles.beneficiaryRow, i < beneficiaries.length - 1 && styles.rowBorder]}>
                <View style={styles.beneficiaryBadge}>
                  <Text style={styles.beneficiaryBadgeText}>{i + 1}</Text>
                </View>
                <View style={styles.beneficiaryInfo}>
                  <Text style={styles.beneficiaryName}>{b.label}</Text>
                  <Text style={styles.beneficiaryAddr}>{truncateAddress(b.wallet.toString(), 6)}</Text>
                </View>
                <View style={styles.percentBadge}>
                  <Text style={styles.percentText}>{(b.shareBps / 100).toFixed(1)}%</Text>
                </View>
              </View>
            ))
          )}
        </View>

        {/* Heartbeat Settings */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <MaterialCommunityIcons name="clock-outline" size={14} color="rgba(255,255,255,0.4)" />
            <Text style={styles.sectionLabel}>HEARTBEAT SETTINGS</Text>
          </View>
          <View style={styles.gridRow}>
            <View style={styles.gridCell}>
              <Text style={styles.gridLabel}>Interval</Text>
              <Text style={styles.gridValue}>
                {heartbeatConfig ? formatDuration(heartbeatConfig.intervalSeconds) : 'Not set'}
              </Text>
            </View>
            <View style={[styles.gridCell, styles.gridCellBorder]}>
              <Text style={styles.gridLabel}>Every</Text>
              <Text style={styles.gridValue}>
                {heartbeatConfig ? `${heartbeatConfig.intervalSeconds / 86400}d` : '-'}
              </Text>
            </View>
            <View style={styles.gridCell}>
              <Text style={styles.gridLabel}>Grace Period</Text>
              <Text style={styles.gridValue}>
                {gracePeriod > 0 ? formatDuration(gracePeriod) : '-'}
              </Text>
            </View>
          </View>
        </View>

        {/* On-Chain Details */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <MaterialCommunityIcons name="flash" size={14} color="rgba(255,255,255,0.4)" />
            <Text style={styles.sectionLabel}>ON-CHAIN DETAILS</Text>
          </View>
          <View style={styles.detailsBody}>
            <DetailRow label="Network" value="Devnet" />
            <DetailRow label="Program" value={truncateAddress(PROGRAM_ID, 4)} mono />
            <DetailRow label="Execution" value="Agent Key (TEE)" />
          </View>
        </View>

        {/* View Execution Log */}
        <TouchableOpacity
          style={styles.execLogBtn}
          onPress={() => navigation.getParent()?.navigate('Status', { screen: 'ExecutionLog' })}
        >
          <MaterialCommunityIcons name="text-box-outline" size={16} color={COLORS.accent} />
          <Text style={styles.execLogBtnText}>View Execution Log</Text>
          <MaterialCommunityIcons name="chevron-right" size={14} color="rgba(255,255,255,0.3)" />
        </TouchableOpacity>

        <View style={{ height: SPACING.xxl }} />
      </ScrollView>
    );
  }

  // Not setup — navigate to Welcome screen
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Estate Plan Setup</Text>
      <Text style={styles.subtitle}>Complete each step to register your vault.</Text>

      <StepCard
        number={1}
        title="Add Beneficiaries"
        description="Add wallet addresses and percentage allocations."
        done={beneficiariesDone}
        onPress={() => navigation.navigate('Welcome')}
      />

      <StepCard
        number={2}
        title="Configure Heartbeat"
        description="Set your check-in interval."
        done={heartbeatDone}
        disabled={!beneficiariesDone}
        onPress={() => navigation.navigate('HeartbeatConfig')}
      />

      <StepCard
        number={3}
        title="Review & Register"
        description="Review your estate plan and register on-chain."
        done={false}
        disabled={!heartbeatDone || !beneficiariesDone}
        onPress={() => navigation.navigate('EstateReview')}
      />

      {hasPartialState && (
        <TouchableOpacity style={styles.startOverBtn} onPress={handleStartOver}>
          <MaterialCommunityIcons name="restart" size={14} color="rgba(255,255,255,0.4)" />
          <Text style={styles.startOverText}>Start Over</Text>
        </TouchableOpacity>
      )}

      <View style={{ height: SPACING.xxl }} />
    </ScrollView>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={[styles.detailValue, mono && { fontFamily: FONTS.mono }]}>{value}</Text>
    </View>
  );
}

function StepCard({
  number,
  title,
  description,
  done,
  disabled,
  onPress,
}: {
  number: number;
  title: string;
  description: string;
  done: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.stepCard, disabled && styles.stepCardDisabled]}
      onPress={onPress}
      disabled={disabled}
    >
      <View style={[styles.stepNumber, done && styles.stepNumberDone]}>
        <Text style={styles.stepNumberText}>
          {done ? '\u2713' : number}
        </Text>
      </View>
      <View style={styles.stepInfo}>
        <Text style={[styles.stepTitle, disabled && styles.stepTitleDisabled]}>
          {title}
        </Text>
        <Text style={styles.stepDescription}>{description}</Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  content: {
    padding: SPACING.md,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: COLORS.textPrimary,
    fontFamily: FONTS.primaryBold,
    marginBottom: SPACING.sm,
  },
  subtitle: {
    fontSize: 14,
    color: COLORS.textSecondary,
    fontFamily: FONTS.primary,
    marginBottom: SPACING.lg,
  },
  // Post-setup: Vault status header
  statusHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 16,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  statusLabel: {
    fontSize: 16,
    fontWeight: '700',
    fontFamily: FONTS.primaryBold,
  },
  statusStageBadge: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.3)',
    fontFamily: FONTS.primary,
  },
  // Post-setup: Sections (reuse EstateReview styling)
  section: {
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    borderRadius: 16,
    marginBottom: 12,
    overflow: 'hidden',
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.4)',
    letterSpacing: 1,
    fontFamily: FONTS.primarySemiBold,
  },
  sectionRow: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  warningText: {
    fontSize: 12,
    color: COLORS.warning,
    fontFamily: FONTS.primary,
  },
  beneficiaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  rowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  beneficiaryBadge: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(153,69,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  beneficiaryBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#9945FF',
    fontFamily: FONTS.primaryBold,
  },
  beneficiaryInfo: { flex: 1 },
  beneficiaryName: {
    fontSize: 13,
    fontWeight: '600',
    color: '#FFFFFF',
    fontFamily: FONTS.primarySemiBold,
  },
  beneficiaryAddr: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.35)',
    fontFamily: FONTS.mono,
    marginTop: 1,
  },
  percentBadge: {
    backgroundColor: 'rgba(153,69,255,0.15)',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  percentText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#9945FF',
    fontFamily: FONTS.primaryBold,
  },
  gridRow: { flexDirection: 'row' },
  gridCell: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 12,
  },
  gridCellBorder: {
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  gridLabel: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.35)',
    fontFamily: FONTS.primary,
    marginBottom: 4,
  },
  gridValue: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.accent,
    fontFamily: FONTS.primaryBold,
  },
  detailsBody: { padding: 16 },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  detailLabel: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.4)',
    fontFamily: FONTS.primary,
  },
  detailValue: {
    fontSize: 12,
    color: '#FFFFFF',
    fontWeight: '500',
    fontFamily: FONTS.primaryMedium,
  },
  execLogBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 12,
  },
  execLogBtnText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '500',
    color: COLORS.accent,
    fontFamily: FONTS.primaryMedium,
  },
  // Pre-setup step cards
  stepCard: {
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    padding: SPACING.md,
    marginBottom: SPACING.sm,
    flexDirection: 'row',
    alignItems: 'center',
  },
  stepCardDisabled: {
    opacity: 0.4,
  },
  stepNumber: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: COLORS.border,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: SPACING.md,
  },
  stepNumberDone: {
    backgroundColor: COLORS.accent,
  },
  stepNumberText: {
    color: COLORS.textPrimary,
    fontSize: 16,
    fontWeight: '700',
    fontFamily: FONTS.primaryBold,
  },
  stepInfo: {
    flex: 1,
  },
  stepTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.textPrimary,
    fontFamily: FONTS.primarySemiBold,
  },
  stepTitleDisabled: {
    color: COLORS.textMuted,
  },
  stepDescription: {
    fontSize: 13,
    color: COLORS.textSecondary,
    marginTop: 2,
    fontFamily: FONTS.primary,
  },
  startOverBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  startOverText: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.4)',
    fontFamily: FONTS.primary,
  },
});
