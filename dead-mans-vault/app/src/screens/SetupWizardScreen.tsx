import React from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useVaultStore } from '../store/useVaultStore';
import { useHeartbeatStore } from '../store/useHeartbeatStore';
import { validateBeneficiaryShares } from '../utils/validation';
import { COLORS, SPACING } from '../utils/constants';

export function SetupWizardScreen() {
  const navigation = useNavigation<any>();
  const { beneficiaries, isSetupComplete, defiPositions } = useVaultStore();
  const heartbeatConfig = useHeartbeatStore((s) => s.config);

  const heartbeatDone = heartbeatConfig !== null;
  const beneficiariesDone = validateBeneficiaryShares(
    beneficiaries.map((b) => b.shareBps),
  );
  const defiDone = defiPositions.length >= 0 && beneficiariesDone; // reviewed if beneficiaries done

  if (isSetupComplete) {
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.checkmark}>&#x2713;</Text>
        <Text style={styles.title}>Vault Active</Text>
        <Text style={styles.subtitle}>
          Your estate plan is registered on-chain and monitoring is active.
        </Text>
        <Text style={styles.detail}>
          {beneficiaries.length} beneficiar{beneficiaries.length === 1 ? 'y' : 'ies'} configured
        </Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Estate Plan Setup</Text>
      <Text style={styles.subtitle}>Complete each step to register your vault.</Text>

      {/* Step 1: Heartbeat */}
      <StepCard
        number={1}
        title="Configure Heartbeat"
        description="Set your heartbeat interval and confirmation methods."
        done={heartbeatDone}
        onPress={() => navigation.navigate('HeartbeatConfig')}
      />

      {/* Step 2: Beneficiaries */}
      <StepCard
        number={2}
        title="Add Beneficiaries"
        description="Add wallet addresses and percentage allocations."
        done={beneficiariesDone}
        onPress={() => navigation.navigate('Beneficiaries')}
      />

      {/* Step 3: DeFi Positions */}
      <StepCard
        number={3}
        title="Review DeFi Positions"
        description="Scan for DeFi positions and set actions."
        done={defiDone && beneficiariesDone}
        disabled={!beneficiariesDone}
        onPress={() => navigation.navigate('DeFiPositions')}
      />

      {/* Step 4: Review & Register */}
      <StepCard
        number={4}
        title="Review & Register"
        description="Review your estate plan and register on-chain."
        done={false}
        disabled={!heartbeatDone || !beneficiariesDone}
        onPress={() => navigation.navigate('EstateReview')}
      />

      <View style={{ height: SPACING.xxl }} />
    </ScrollView>
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
  centerContainer: {
    flex: 1,
    backgroundColor: COLORS.bg,
    justifyContent: 'center',
    alignItems: 'center',
    padding: SPACING.xl,
  },
  checkmark: {
    fontSize: 48,
    color: COLORS.healthy,
    marginBottom: SPACING.md,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: COLORS.textPrimary,
    marginBottom: SPACING.sm,
  },
  subtitle: {
    fontSize: 14,
    color: COLORS.textSecondary,
    marginBottom: SPACING.lg,
  },
  detail: {
    fontSize: 14,
    color: COLORS.accent,
    marginTop: SPACING.sm,
  },
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
    backgroundColor: COLORS.healthy,
  },
  stepNumberText: {
    color: COLORS.textPrimary,
    fontSize: 16,
    fontWeight: '700',
  },
  stepInfo: {
    flex: 1,
  },
  stepTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.textPrimary,
  },
  stepTitleDisabled: {
    color: COLORS.textMuted,
  },
  stepDescription: {
    fontSize: 13,
    color: COLORS.textSecondary,
    marginTop: 2,
  },
});
