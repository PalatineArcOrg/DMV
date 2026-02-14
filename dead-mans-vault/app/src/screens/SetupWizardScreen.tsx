import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { COLORS, SPACING } from '../utils/constants';

export function SetupWizardScreen() {
  const navigation = useNavigation<any>();

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Estate Plan Setup</Text>
      <Text style={styles.subtitle}>Configure your vault</Text>
      <Text style={styles.description}>
        Start by configuring your heartbeat settings, then set up beneficiaries
        and estate plan details.
      </Text>

      <TouchableOpacity
        style={styles.button}
        onPress={() => navigation.navigate('HeartbeatConfig')}
      >
        <Text style={styles.buttonText}>Configure Heartbeat</Text>
      </TouchableOpacity>

      <View style={styles.comingSoon}>
        <Text style={styles.comingSoonText}>
          Beneficiary setup and estate plan configuration coming in Phase 4.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
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
    color: COLORS.accent,
    marginBottom: SPACING.md,
  },
  description: {
    fontSize: 14,
    color: COLORS.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: SPACING.xl,
  },
  button: {
    backgroundColor: COLORS.accent,
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.xl,
    borderRadius: 12,
    marginBottom: SPACING.lg,
  },
  buttonText: {
    color: COLORS.textPrimary,
    fontSize: 16,
    fontWeight: '700',
  },
  comingSoon: {
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    padding: SPACING.md,
    width: '100%',
  },
  comingSoonText: {
    fontSize: 13,
    color: COLORS.textMuted,
    textAlign: 'center',
  },
});
