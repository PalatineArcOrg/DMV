import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS, FONTS } from '../utils/constants';

interface StepIndicatorProps {
  currentStep: number;
  totalSteps: number;
  labels?: string[];
}

export function StepIndicator({ currentStep, totalSteps, labels }: StepIndicatorProps) {
  const steps = Array.from({ length: totalSteps }, (_, i) => i + 1);

  return (
    <View style={styles.container}>
      {/* Dots and connectors */}
      <View style={styles.dotsRow}>
        {steps.map((step, i) => {
          const isCompleted = step < currentStep;
          const isActive = step === currentStep;
          const isPending = step > currentStep;

          return (
            <React.Fragment key={step}>
              <View
                style={[
                  styles.dot,
                  isCompleted && styles.dotCompleted,
                  isActive && styles.dotActive,
                  isPending && styles.dotPending,
                ]}
              >
                {isCompleted ? (
                  <MaterialCommunityIcons name="check" size={14} color="#FFFFFF" />
                ) : (
                  <Text
                    style={[
                      styles.dotText,
                      isActive && styles.dotTextActive,
                      isPending && styles.dotTextPending,
                    ]}
                  >
                    {step}
                  </Text>
                )}
              </View>
              {i < totalSteps - 1 && (
                <View
                  style={[
                    styles.connector,
                    { backgroundColor: step < currentStep ? COLORS.accent : 'rgba(255,255,255,0.08)' },
                  ]}
                />
              )}
            </React.Fragment>
          );
        })}
      </View>

      {/* Labels */}
      {labels && labels.length === totalSteps && (
        <View style={styles.labelsRow}>
          {steps.map((step, i) => {
            const isCompleted = step < currentStep;
            const isActive = step === currentStep;
            return (
              <React.Fragment key={step}>
                <Text
                  style={[
                    styles.labelText,
                    isActive && styles.labelActive,
                    isCompleted && styles.labelCompleted,
                  ]}
                  numberOfLines={1}
                >
                  {labels[i]}
                </Text>
                {i < totalSteps - 1 && <View style={styles.labelSpacer} />}
              </React.Fragment>
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: 8,
  },
  dotsRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  dot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  dotCompleted: {
    backgroundColor: COLORS.accent,
  },
  dotActive: {
    backgroundColor: 'rgba(0,255,163,0.15)',
    borderWidth: 1.5,
    borderColor: COLORS.accent,
  },
  dotPending: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  dotText: {
    fontSize: 11,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.3)',
    fontFamily: FONTS.primarySemiBold,
  },
  dotTextActive: {
    color: COLORS.accent,
  },
  dotTextPending: {
    color: 'rgba(255,255,255,0.3)',
  },
  connector: {
    flex: 1,
    height: 1,
    marginHorizontal: 4,
  },
  labelsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  labelText: {
    width: 28,
    textAlign: 'center',
    fontSize: 9,
    color: 'rgba(255,255,255,0.2)',
    fontFamily: FONTS.primary,
    fontWeight: '400',
  },
  labelActive: {
    color: COLORS.accent,
    fontWeight: '600',
    fontFamily: FONTS.primarySemiBold,
  },
  labelCompleted: {
    color: 'rgba(0,255,163,0.6)',
  },
  labelSpacer: {
    flex: 1,
  },
});
