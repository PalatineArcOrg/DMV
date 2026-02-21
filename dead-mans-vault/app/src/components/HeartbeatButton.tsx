import React, { useEffect, useRef, useCallback, useState } from 'react';
import {
  TouchableOpacity,
  Text,
  View,
  StyleSheet,
  Animated,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS, FONTS, STAGE_CONFIG } from '../utils/constants';
import { EscalationStage } from '../types';
import { EcgLine } from './EcgLine';

interface HeartbeatButtonProps {
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  label?: string;
  stage?: EscalationStage;
  secondsRemaining?: number;
}

const ICON_MAP: Record<string, keyof typeof MaterialCommunityIcons.glyphMap> = {
  'shield-check': 'shield-check',
  'clock-outline': 'clock-outline',
  'alert': 'alert',
  'alert-octagon': 'alert-octagon',
  'flash': 'flash',
};

function getButtonSize(stage: number): number {
  if (stage <= 1) return 120;
  if (stage === 2) return 130;
  return 140;
}

function getPulseDuration(stage: number): number {
  if (stage === 0) return 3000; // Slow breathing
  if (stage <= 1) return 2500;
  if (stage === 2) return 1800;
  if (stage === 3) return 1200;
  return 1800;
}

export function HeartbeatButton({
  onPress,
  disabled = false,
  loading = false,
  label,
  stage = 0,
  secondsRemaining = 0,
}: HeartbeatButtonProps) {
  const [confirmed, setConfirmed] = useState(false);
  const wasLoading = useRef(false);

  const cfg = STAGE_CONFIG[stage] || STAGE_CONFIG[0];
  const buttonSize = getButtonSize(stage);
  const pulseDuration = getPulseDuration(stage);
  const containerSize = buttonSize + 80;

  // Pulse ring animations
  const pulseScale0 = useRef(new Animated.Value(1)).current;
  const pulseScale1 = useRef(new Animated.Value(1)).current;
  const pulseScale2 = useRef(new Animated.Value(1)).current;
  const pulseOpacity0 = useRef(new Animated.Value(0.4)).current;
  const pulseOpacity1 = useRef(new Animated.Value(0.3)).current;
  const pulseOpacity2 = useRef(new Animated.Value(0.2)).current;

  // Spinner rotation
  const spinAnim = useRef(new Animated.Value(0)).current;

  // Confirm check scale
  const checkScale = useRef(new Animated.Value(0)).current;

  // Icon pulse for stage >= 1
  const iconScale = useRef(new Animated.Value(1)).current;

  // Stage 0 heartbeat animation — heart pulses periodically
  const heartBeatScale = useRef(new Animated.Value(1)).current;

  const pulseScales = [pulseScale0, pulseScale1, pulseScale2];
  const pulseOpacities = [pulseOpacity0, pulseOpacity1, pulseOpacity2];

  const showEcg = stage === 4;
  const showRingPulse = stage >= 0 && stage <= 3;

  // Pulse ring animation — stages 1-3 continuous loop
  useEffect(() => {
    if (stage < 1 || stage > 3) {
      // S0: rings start invisible (driven by beat effect)
      // S4+: no rings
      pulseScales.forEach(s => s.setValue(1));
      pulseOpacities.forEach(o => o.setValue(0));
      return;
    }

    // Stages 1-3: Existing expand-fade pulse — unchanged
    const animations = pulseScales.map((scale, i) => {
      const opacity = pulseOpacities[i];
      const delay = i * (pulseDuration / 3);
      return Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.parallel([
            Animated.timing(scale, {
              toValue: 1.6 + i * 0.2,
              duration: pulseDuration,
              useNativeDriver: true,
            }),
            Animated.timing(opacity, {
              toValue: 0,
              duration: pulseDuration,
              useNativeDriver: true,
            }),
          ]),
          Animated.parallel([
            Animated.timing(scale, { toValue: 1, duration: 0, useNativeDriver: true }),
            Animated.timing(opacity, { toValue: 0.4 - i * 0.1, duration: 0, useNativeDriver: true }),
          ]),
        ]),
      );
    });

    animations.forEach(a => a.start());
    return () => animations.forEach(a => a.stop());
  }, [stage, pulseDuration]);

  // Spinner animation
  useEffect(() => {
    if (loading) {
      const spin = Animated.loop(
        Animated.timing(spinAnim, {
          toValue: 1,
          duration: 1000,
          useNativeDriver: true,
        }),
      );
      spin.start();
      return () => spin.stop();
    } else {
      spinAnim.setValue(0);
    }
  }, [loading]);

  // Icon scale pulse for active stages
  useEffect(() => {
    if (stage >= 1 && stage <= 3) {
      const anim = Animated.loop(
        Animated.sequence([
          Animated.timing(iconScale, { toValue: 1.1, duration: 750, useNativeDriver: true }),
          Animated.timing(iconScale, { toValue: 1, duration: 750, useNativeDriver: true }),
        ]),
      );
      anim.start();
      return () => anim.stop();
    } else {
      iconScale.setValue(1);
    }
  }, [stage]);

  // Stage 0: heartbeat ripple — heart thumps + rings burst outward (~72 BPM)
  useEffect(() => {
    if (stage !== 0) {
      heartBeatScale.setValue(1);
      return;
    }
    const BEAT_INTERVAL = 1200; // ~50 BPM — realistic resting heartbeat feel
    const fireBeat = () => {
      // Heart thump — quick systole/diastole
      Animated.sequence([
        Animated.timing(heartBeatScale, { toValue: 1.18, duration: 80, useNativeDriver: true }),
        Animated.timing(heartBeatScale, { toValue: 0.96, duration: 60, useNativeDriver: true }),
        Animated.timing(heartBeatScale, { toValue: 1, duration: 120, useNativeDriver: true }),
      ]).start();

      // Staggered ring burst — ripple outward
      pulseScales.forEach((scale, i) => {
        const opacity = pulseOpacities[i];
        const delay = i * 60;
        const duration = 400 + i * 100;
        const targetScale = 1.4 + i * 0.2;
        const peakOpacity = 0.35 - i * 0.08;

        Animated.sequence([
          Animated.delay(delay),
          Animated.parallel([
            Animated.timing(scale, { toValue: targetScale, duration, useNativeDriver: true }),
            Animated.sequence([
              Animated.timing(opacity, { toValue: peakOpacity, duration: 60, useNativeDriver: true }),
              Animated.timing(opacity, { toValue: 0, duration: duration - 60, useNativeDriver: true }),
            ]),
          ]),
          // Reset for next beat
          Animated.parallel([
            Animated.timing(scale, { toValue: 1, duration: 0, useNativeDriver: true }),
            Animated.timing(opacity, { toValue: 0, duration: 0, useNativeDriver: true }),
          ]),
        ]).start();
      });
    };
    fireBeat();
    const interval = setInterval(fireBeat, BEAT_INTERVAL);
    return () => clearInterval(interval);
  }, [stage]);

  // Detect loading -> not loading transition to show confirmed state
  useEffect(() => {
    if (wasLoading.current && !loading) {
      setConfirmed(true);
      checkScale.setValue(0);
      Animated.spring(checkScale, {
        toValue: 1,
        friction: 5,
        tension: 100,
        useNativeDriver: true,
      }).start();
      const timer = setTimeout(() => setConfirmed(false), 800);
      return () => clearTimeout(timer);
    }
    wasLoading.current = loading;
  }, [loading]);

  const handlePress = useCallback(() => {
    if (confirmed) return;
    onPress();
  }, [onPress, confirmed]);

  const isDisabledState = disabled || stage === 4;
  const displayLabel = label ?? cfg.buttonLabel;
  const iconName = ICON_MAP[cfg.icon] || 'shield-check';
  const iconSize = stage >= 3 ? 28 : 24;
  const spinRotation = spinAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  return (
    <View style={[styles.container, { width: containerSize, height: containerSize + 40 }]}>
      {/* Pulse area — fixed square container for button + rings/ecg */}
      <View style={[styles.pulseArea, { width: containerSize, height: containerSize }]}>
        {/* Pulse rings — S0: burst on heartbeat, S1-3: continuous loop */}
        {showRingPulse && [0, 1, 2].map(i => (
          <Animated.View
            key={i}
            style={[
              styles.pulseRing,
              {
                width: buttonSize,
                height: buttonSize,
                borderRadius: buttonSize / 2,
                borderColor: cfg.color,
                transform: [{ scale: pulseScales[i] }],
                opacity: pulseOpacities[i],
                position: 'absolute',
              },
            ]}
          />
        ))}

        {/* Main circular button */}
        <TouchableOpacity
          onPress={handlePress}
          disabled={isDisabledState || loading || confirmed}
          activeOpacity={0.8}
          style={[
            styles.button,
            {
              width: buttonSize,
              height: buttonSize,
              borderRadius: buttonSize / 2,
              backgroundColor: confirmed ? '#00FFA3' : cfg.dimColor,
              borderColor: confirmed ? '#00FFA3' : cfg.borderColor,
              opacity: isDisabledState && !loading ? 0.5 : 1,
              shadowColor: cfg.glowColor,
              shadowOffset: { width: 0, height: 0 },
              shadowOpacity: stage >= 3 ? 0.8 : 0.4,
              shadowRadius: stage >= 3 ? 20 : 12,
              elevation: stage >= 3 ? 12 : 6,
              overflow: 'hidden',
            },
          ]}
        >
          {/* ECG flatline — Stage 4 only */}
          {showEcg && (
            <View style={[styles.ecgOverlay, { opacity: 0.5 }]} pointerEvents="none">
              <EcgLine
                width={buttonSize}
                height={buttonSize * 0.4}
                color={cfg.color}
                speed={0}
                strokeWidth={1.5}
              />
            </View>
          )}

          {confirmed ? (
            <Animated.View style={{ transform: [{ scale: checkScale }] }}>
              <MaterialCommunityIcons name="check" size={28} color="#07090F" />
            </Animated.View>
          ) : loading ? (
            <Animated.View
              style={[
                styles.spinner,
                {
                  borderColor: cfg.color,
                  borderTopColor: 'transparent',
                  transform: [{ rotate: spinRotation }],
                },
              ]}
            />
          ) : (
            <Animated.View style={{ transform: [{ scale: stage === 0 ? heartBeatScale : iconScale }] }}>
              {stage === 0 ? (
                <MaterialCommunityIcons name="heart-pulse" size={36} color={cfg.color} />
              ) : (
                <MaterialCommunityIcons name={iconName} size={iconSize} color={cfg.color} />
              )}
            </Animated.View>
          )}
        </TouchableOpacity>
      </View>

      {/* Label */}
      <View style={styles.labelContainer}>
        <Text style={[styles.label, { color: confirmed ? '#00FFA3' : cfg.color }]}>
          {confirmed ? '\u2713 Vault Secured' : displayLabel}
        </Text>
        {stage > 0 && stage < 4 && !confirmed && (
          <Text style={styles.sublabel}>{cfg.sublabel}</Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
  },
  pulseArea: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  ecgOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pulseRing: {
    borderWidth: 1,
  },
  button: {
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  spinner: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 3,
  },
  labelContainer: {
    alignItems: 'center',
    marginTop: 0,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: FONTS.primarySemiBold,
  },
  sublabel: {
    color: 'rgba(255,255,255,0.35)',
    fontSize: 11,
    marginTop: 2,
    fontFamily: FONTS.primary,
  },
});
