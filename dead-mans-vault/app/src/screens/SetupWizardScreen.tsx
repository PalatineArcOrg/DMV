import React from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useVaultStore } from '../store/useVaultStore';
import { useHeartbeatStore } from '../store/useHeartbeatStore';
import { validateBeneficiaryShares } from '../utils/validation';
import { COLORS, SPACING } from '../utils/constants';

export function SetupWizardScreen() {
  const navigation = useNavigation<any>();
  const { beneficiaries, isSetupComplete } = useVaultStore();
  const heartbeatConfig = useHeartbeatStore((s) => s.config);

  const heartbeatDone = heartbeatConfig !== null;
  const beneficiariesDone = validateBeneficiaryShares(
    beneficiaries.map((b) => b.shareBps),
  );

  if (isSetupComplete) {
    return (
      <View style={styles.centerContainer}>
        <View style={styles.checkCircle}>
          <Text style={styles.checkmark}>{'\u2713'}</Text>
        </View>
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
  checkCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: COLORS.accent + '20',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: SPACING.md,
  },
  checkmark: {
    fontSize: 32,
    color: COLORS.accent,
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
    textAlign: 'center',
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
    backgroundColor: COLORS.accent,
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
