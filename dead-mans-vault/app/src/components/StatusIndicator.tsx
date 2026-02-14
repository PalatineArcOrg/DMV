import React from 'react';
import { View, StyleSheet, Animated } from 'react-native';
import { COLORS } from '../utils/constants';
import { EscalationStage } from '../types';

interface StatusIndicatorProps {
  stage: EscalationStage;
  isActive: boolean;
}

function getColor(stage: EscalationStage, isActive: boolean): string {
  if (!isActive) return COLORS.textMuted;
  switch (stage) {
    case 0:
      return COLORS.healthy;
    case 1:
    case 2:
      return COLORS.warning;
    case 3:
    case 4:
      return COLORS.critical;
    default:
      return COLORS.textMuted;
  }
}

function getLabel(stage: EscalationStage, isActive: boolean): string {
  if (!isActive) return 'Inactive';
  switch (stage) {
    case 0:
      return 'Normal';
    case 1:
      return 'Reminder';
    case 2:
      return 'Alert';
    case 3:
      return 'Warning';
    case 4:
      return 'Executing';
    default:
      return 'Unknown';
  }
}

export function StatusIndicator({ stage, isActive }: StatusIndicatorProps) {
  const color = getColor(stage, isActive);
  const label = getLabel(stage, isActive);

  return (
    <View style={styles.container}>
      <View style={[styles.orb, { backgroundColor: color }]}>
        <View style={[styles.orbInner, { backgroundColor: color }]} />
      </View>
      <View style={styles.labelContainer}>
        <Animated.Text style={[styles.label, { color }]}>
          {label}
        </Animated.Text>
        <Animated.Text style={styles.sublabel}>Stage {stage}</Animated.Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    paddingVertical: 24,
  },
  orb: {
    width: 80,
    height: 80,
    borderRadius: 40,
    opacity: 0.9,
    justifyContent: 'center',
    alignItems: 'center',
  },
  orbInner: {
    width: 48,
    height: 48,
    borderRadius: 24,
    opacity: 0.6,
  },
  labelContainer: {
    alignItems: 'center',
    marginTop: 12,
  },
  label: {
    fontSize: 18,
    fontWeight: '600',
  },
  sublabel: {
    fontSize: 13,
    color: COLORS.textMuted,
    marginTop: 2,
  },
});
