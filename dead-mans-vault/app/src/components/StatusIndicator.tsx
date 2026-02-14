import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import { COLORS, SPACING } from '../utils/constants';
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
      return 'Vault Active';
    case 1:
      return 'Heartbeat Overdue';
    case 2:
      return 'Emergency Alert';
    case 3:
      return 'Final Warning';
    case 4:
      return 'Executing';
    default:
      return 'Unknown';
  }
}

function getPulseConfig(stage: EscalationStage, isActive: boolean) {
  if (!isActive) return { minScale: 1, maxScale: 1, duration: 2000 };
  switch (stage) {
    case 0:
      return { minScale: 0.95, maxScale: 1.08, duration: 2000 };
    case 1:
    case 2:
      return { minScale: 0.92, maxScale: 1.1, duration: 1200 };
    case 3:
    case 4:
      return { minScale: 0.9, maxScale: 1.15, duration: 500 };
    default:
      return { minScale: 1, maxScale: 1, duration: 2000 };
  }
}

export function StatusIndicator({ stage, isActive }: StatusIndicatorProps) {
  const color = getColor(stage, isActive);
  const label = getLabel(stage, isActive);
  const pulseConfig = getPulseConfig(stage, isActive);

  const pulseAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!isActive) {
      pulseAnim.setValue(0);
      return;
    }

    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: pulseConfig.duration,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 0,
          duration: pulseConfig.duration,
          useNativeDriver: true,
        }),
      ]),
    );
    animation.start();

    return () => animation.stop();
  }, [stage, isActive, pulseConfig.duration]);

  const scale = pulseAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [pulseConfig.minScale, pulseConfig.maxScale],
  });

  const glowScale = pulseAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [pulseConfig.minScale * 0.95, pulseConfig.maxScale * 1.1],
  });

  const glowOpacity = pulseAnim.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [0.15, 0.3, 0.15],
  });

  return (
    <View style={styles.container}>
      {/* Glow ring */}
      <Animated.View
        style={[
          styles.glowRing,
          {
            backgroundColor: color + '30',
            transform: [{ scale: glowScale }],
            opacity: glowOpacity,
          },
        ]}
      />

      {/* Main orb */}
      <Animated.View
        style={[
          styles.orb,
          {
            backgroundColor: color,
            transform: [{ scale }],
            shadowColor: color,
            shadowOpacity: 0.6,
            shadowRadius: 20,
            shadowOffset: { width: 0, height: 0 },
            elevation: 12,
          },
        ]}
      >
        <View style={[styles.orbHighlight, { backgroundColor: color + 'CC' }]} />
      </Animated.View>

      {/* Label */}
      <View style={styles.labelContainer}>
        <Text style={[styles.label, { color }]}>{label}</Text>
        <Text style={styles.sublabel}>
          {isActive ? `Stage ${stage}` : 'Setup Required'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    paddingVertical: SPACING.lg,
    justifyContent: 'center',
  },
  glowRing: {
    position: 'absolute',
    width: 120,
    height: 120,
    borderRadius: 60,
  },
  orb: {
    width: 80,
    height: 80,
    borderRadius: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  orbHighlight: {
    width: 36,
    height: 36,
    borderRadius: 18,
    opacity: 0.5,
  },
  labelContainer: {
    alignItems: 'center',
    marginTop: SPACING.sm,
  },
  label: {
    fontSize: 18,
    fontWeight: '700',
  },
  sublabel: {
    fontSize: 13,
    color: COLORS.textMuted,
    marginTop: 2,
  },
});
