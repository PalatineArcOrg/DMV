import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { COLORS, SPACING } from '../utils/constants';
import { EscalationStage } from '../types';
import { formatDuration } from '../utils/formatting';

interface EscalationBannerProps {
  stage: EscalationStage;
  secondsRemaining: number;
}

function formatCountdown(seconds: number): string {
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
  return formatDuration(seconds);
}

function getBannerConfig(stage: EscalationStage) {
  switch (stage) {
    case 1:
      return {
        bg: COLORS.warning + '20',
        border: COLORS.warning,
        icon: 'favorite' as const,
        iconColor: COLORS.warning,
        text: 'Heartbeat overdue. Confirm to reset.',
      };
    case 2:
      return {
        bg: COLORS.warning + '30',
        border: COLORS.warning,
        icon: 'warning' as const,
        iconColor: COLORS.warning,
        text: 'Emergency contacts notified. Confirm to prevent execution.',
      };
    case 3:
      return {
        bg: COLORS.critical + '30',
        border: COLORS.critical,
        icon: 'error' as const,
        iconColor: COLORS.critical,
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
      <View style={styles.row}>
        <MaterialIcons
          name={config.icon}
          size={20}
          color={config.iconColor}
          style={styles.icon}
        />
        <Text style={styles.text}>{config.text}</Text>
      </View>
      {secondsRemaining > 0 && (
        <Text style={styles.countdown}>
          Escalating in {formatCountdown(secondsRemaining)}
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  icon: {
    marginRight: SPACING.sm,
  },
  text: {
    color: COLORS.textPrimary,
    fontSize: 14,
    fontWeight: '500',
    flex: 1,
  },
  countdown: {
    color: COLORS.textSecondary,
    fontSize: 12,
    marginTop: SPACING.xs,
    marginLeft: 28,
  },
});
