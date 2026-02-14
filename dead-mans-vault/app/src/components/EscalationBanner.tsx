import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { COLORS, SPACING } from '../utils/constants';
import { EscalationStage } from '../types';
import { formatDuration } from '../utils/formatting';

interface EscalationBannerProps {
  stage: EscalationStage;
  secondsRemaining: number;
}

function getBannerConfig(stage: EscalationStage) {
  switch (stage) {
    case 1:
      return {
        bg: COLORS.warning + '20',
        border: COLORS.warning,
        icon: '\u2764\uFE0F',
        text: 'Heartbeat overdue. Confirm to reset.',
      };
    case 2:
      return {
        bg: COLORS.warning + '30',
        border: COLORS.warning,
        icon: '\u26A0\uFE0F',
        text: 'Emergency contacts notified. Confirm to prevent execution.',
      };
    case 3:
      return {
        bg: COLORS.critical + '30',
        border: COLORS.critical,
        icon: '\uD83D\uDD34',
        text: 'FINAL WARNING. Estate plan executes soon.',
      };
    default:
      return null;
  }
}

export function EscalationBanner({ stage, secondsRemaining }: EscalationBannerProps) {
  const config = getBannerConfig(stage);
  if (!config || stage === 0 || stage === 4) return null;

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: config.bg, borderColor: config.border },
      ]}
    >
      <Text style={styles.text}>
        {config.icon} {config.text}
      </Text>
      {secondsRemaining > 0 && (
        <Text style={styles.countdown}>
          Escalating in {formatDuration(secondsRemaining)}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderWidth: 1,
    borderRadius: 8,
    padding: SPACING.md,
    marginHorizontal: SPACING.md,
    marginVertical: SPACING.sm,
  },
  text: {
    color: COLORS.textPrimary,
    fontSize: 14,
    fontWeight: '500',
  },
  countdown: {
    color: COLORS.textSecondary,
    fontSize: 12,
    marginTop: SPACING.xs,
  },
});
