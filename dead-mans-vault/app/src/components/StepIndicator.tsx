import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { COLORS, SPACING } from '../utils/constants';

interface StepIndicatorProps {
  currentStep: number;
  totalSteps: number;
}

export function StepIndicator({ currentStep, totalSteps }: StepIndicatorProps) {
  const progress = currentStep / totalSteps;

  return (
    <View style={styles.container}>
      {/* Progress bar */}
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${progress * 100}%` }]} />
      </View>

      {/* Step dots */}
      <View style={styles.dots}>
        {Array.from({ length: totalSteps }, (_, i) => {
          const step = i + 1;
          const isCompleted = step < currentStep;
          const isActive = step === currentStep;

          return (
            <View
              key={step}
              style={[
                styles.dot,
                isCompleted && styles.dotCompleted,
                isActive && styles.dotActive,
              ]}
            >
              {isCompleted ? (
                <Text style={styles.checkText}>{'\u2713'}</Text>
              ) : (
                <Text
                  style={[
                    styles.dotText,
                    isActive && styles.dotTextActive,
                  ]}
                >
                  {step}
                </Text>
              )}
            </View>
          );
        })}
      </View>

      <Text style={styles.stepLabel}>
        Step {currentStep} of {totalSteps}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  track: {
    height: 3,
    backgroundColor: COLORS.border,
    borderRadius: 2,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    backgroundColor: COLORS.accent,
    borderRadius: 2,
  },
  dots: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: SPACING.sm,
  },
  dot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: COLORS.surface,
    borderWidth: 2,
    borderColor: COLORS.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  dotCompleted: {
    backgroundColor: COLORS.accent,
    borderColor: COLORS.accent,
  },
  dotActive: {
    borderColor: COLORS.accent,
    backgroundColor: COLORS.surface,
  },
  dotText: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.textMuted,
  },
  dotTextActive: {
    color: COLORS.accent,
  },
  checkText: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.textPrimary,
  },
  stepLabel: {
    fontSize: 12,
    color: COLORS.textMuted,
    textAlign: 'center',
    marginTop: SPACING.xs,
  },
});
