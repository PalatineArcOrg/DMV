import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS, FONTS, STAGE_CONFIG } from '../utils/constants';
import { EscalationStage } from '../types';

interface StatusIndicatorProps {
  stage: EscalationStage;
  isActive: boolean;
}

export function StatusIndicator({ stage, isActive }: StatusIndicatorProps) {
  const cfg = STAGE_CONFIG[stage] || STAGE_CONFIG[0];
  const iconScale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (isActive && stage >= 1) {
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
  }, [stage, isActive]);

  const stageStatus = stage === 4 ? 'Irreversible' : stage === 0 ? 'Healthy' : 'Action required';
  const label = isActive ? cfg.label : 'Inactive';
  const color = isActive ? cfg.color : COLORS.textMuted;

  return (
    <View style={[styles.container, { backgroundColor: isActive ? cfg.dimColor : 'transparent', borderBottomColor: isActive ? cfg.borderColor : COLORS.borderLight }]}>
      <View style={styles.row}>
        <Animated.View
          style={[
            styles.iconBadge,
            {
              backgroundColor: isActive ? cfg.dimColor : 'rgba(255,255,255,0.06)',
              borderColor: isActive ? cfg.borderColor : 'rgba(255,255,255,0.1)',
              transform: [{ scale: iconScale }],
            },
          ]}
        >
          <MaterialCommunityIcons
            name={(cfg.icon as any) || 'pulse'}
            size={13}
            color={color}
          />
        </Animated.View>
        <View style={styles.labelColumn}>
          <Text style={[styles.label, { color }]}>{label}</Text>
          <Text style={styles.sublabel}>
            {isActive ? `Stage ${stage} \u00B7 ${stageStatus}` : 'Setup Required'}
          </Text>
        </View>
      </View>
      <View style={[styles.statusDot, { backgroundColor: cfg.dimColor, borderColor: cfg.borderColor }]}>
        <Text style={{ color, fontSize: 10, fontWeight: '700' }}>{'\u25CF'}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  iconBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  labelColumn: {
    flexDirection: 'column',
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    fontFamily: FONTS.primaryBold,
  },
  sublabel: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.4)',
    fontFamily: FONTS.primary,
  },
  statusDot: {
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderWidth: 1,
  },
});
