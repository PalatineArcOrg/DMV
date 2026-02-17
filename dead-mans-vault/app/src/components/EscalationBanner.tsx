import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS, FONTS, STAGE_CONFIG } from '../utils/constants';
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

const ICON_MAP: Record<number, keyof typeof MaterialCommunityIcons.glyphMap> = {
  1: 'clock-outline',
  2: 'alert',
  3: 'alert-octagon',
};

export function EscalationBanner({ stage, secondsRemaining }: EscalationBannerProps) {
  if (stage === 0 || stage === 4) return null;

  const cfg = STAGE_CONFIG[stage] || STAGE_CONFIG[1];
  const iconName = ICON_MAP[stage] || 'alert';

  const textMap: Record<number, string> = {
    1: 'Heartbeat overdue. Confirm to reset.',
    2: 'Emergency contacts notified. Confirm to prevent execution.',
    3: 'FINAL WARNING. Estate plan executes soon.',
  };

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: cfg.dimColor, borderColor: cfg.borderColor },
      ]}
    >
      <View style={styles.row}>
        <MaterialCommunityIcons
          name={iconName}
          size={18}
          color={cfg.color}
          style={styles.icon}
        />
        <Text style={[styles.text, { fontFamily: FONTS.primarySemiBold }]}>{textMap[stage]}</Text>
      </View>
      {secondsRemaining > 0 && (
        <Text style={[styles.countdown, { fontFamily: FONTS.primary }]}>
          Escalating in {formatCountdown(secondsRemaining)}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    marginHorizontal: 16,
    marginVertical: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  icon: {
    marginRight: 8,
  },
  text: {
    color: COLORS.textPrimary,
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
  },
  countdown: {
    color: COLORS.textSecondary,
    fontSize: 11,
    marginTop: 4,
    marginLeft: 26,
  },
});
