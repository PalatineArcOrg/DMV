import React, { useEffect, useRef, useCallback } from 'react';
import {
  TouchableOpacity,
  Text,
  View,
  StyleSheet,
  ActivityIndicator,
  Animated,
} from 'react-native';
import { COLORS, SPACING } from '../utils/constants';
import { EscalationStage } from '../types';

interface HeartbeatButtonProps {
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  label?: string;
  stage?: EscalationStage;
  secondsRemaining?: number;
}

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return `${h}h ${rm}m`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function getStageConfig(stage: EscalationStage) {
  switch (stage) {
    case 0:
      return {
        bg: 'transparent',
        borderColor: COLORS.accent,
        textColor: COLORS.accent,
        label: 'Vault Active',
        showPulse: false,
      };
    case 1:
      return {
        bg: COLORS.warning + '15',
        borderColor: COLORS.warning,
        textColor: COLORS.warning,
        label: 'Confirm Heartbeat',
        showPulse: true,
      };
    case 2:
      return {
        bg: COLORS.warning + '25',
        borderColor: COLORS.warning,
        textColor: COLORS.warning,
        label: 'Confirm Heartbeat',
        showPulse: true,
      };
    case 3:
      return {
        bg: COLORS.critical + '25',
        borderColor: COLORS.critical,
        textColor: COLORS.critical,
        label: 'CONFIRM NOW',
        showPulse: true,
      };
    case 4:
      return {
        bg: COLORS.critical + '15',
        borderColor: COLORS.critical,
        textColor: COLORS.critical,
        label: 'Executing...',
        showPulse: false,
      };
    default:
      return {
        bg: 'transparent',
        borderColor: COLORS.border,
        textColor: COLORS.textMuted,
        label: 'Setup Required',
        showPulse: false,
      };
  }
}

export function HeartbeatButton({
  onPress,
  disabled = false,
  loading = false,
  label,
  stage = 0,
  secondsRemaining = 0,
}: HeartbeatButtonProps) {
  const borderAnim = useRef(new Animated.Value(0)).current;
  const flashAnim = useRef(new Animated.Value(0)).current;

  const config = getStageConfig(stage);
  const displayLabel = label ?? config.label;

  // Pulsing border for warning/critical stages
  useEffect(() => {
    if (!config.showPulse) {
      borderAnim.setValue(0);
      return;
    }

    const duration = stage >= 3 ? 400 : 800;
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(borderAnim, {
          toValue: 1,
          duration,
          useNativeDriver: false,
        }),
        Animated.timing(borderAnim, {
          toValue: 0,
          duration,
          useNativeDriver: false,
        }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [stage, config.showPulse]);

  const handlePress = useCallback(() => {
    // Flash green on confirmation
    flashAnim.setValue(1);
    Animated.timing(flashAnim, {
      toValue: 0,
      duration: 600,
      useNativeDriver: false,
    }).start();

    onPress();
  }, [onPress]);

  const animatedBorderColor = config.showPulse
    ? borderAnim.interpolate({
        inputRange: [0, 1],
        outputRange: [config.borderColor + '66', config.borderColor],
      })
    : config.borderColor;

  const flashBg = flashAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [config.bg || COLORS.surface, COLORS.healthy + '40'],
  });

  const isDisabledState = disabled || stage === 4;

  return (
    <TouchableOpacity
      onPress={handlePress}
      disabled={isDisabledState || loading}
      activeOpacity={0.7}
    >
      <Animated.View
        style={[
          styles.button,
          {
            backgroundColor: flashBg,
            borderColor: animatedBorderColor,
            borderWidth: 1.5,
            opacity: isDisabledState ? 0.5 : 1,
          },
        ]}
      >
        {loading ? (
          <ActivityIndicator color={config.textColor} />
        ) : (
          <View style={styles.content}>
            <Text
              style={[
                styles.text,
                { color: config.textColor },
                stage >= 3 && styles.textLarge,
              ]}
            >
              {displayLabel}
            </Text>
            {stage > 0 && stage < 4 && secondsRemaining > 0 && (
              <Text style={[styles.countdown, { color: config.textColor }]}>
                {formatCountdown(secondsRemaining)} remaining
              </Text>
            )}
          </View>
        )}
      </Animated.View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 64,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: SPACING.md,
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.xl,
  },
  content: {
    alignItems: 'center',
  },
  text: {
    fontSize: 16,
    fontWeight: '700',
  },
  textLarge: {
    fontSize: 18,
  },
  countdown: {
    fontSize: 13,
    marginTop: SPACING.xs,
    opacity: 0.8,
  },
});
