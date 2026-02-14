import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { COLORS, SPACING, HEARTBEAT_INTERVALS } from '../utils/constants';
import { formatDuration } from '../utils/formatting';
import { HeartbeatConfig } from '../types';
import { useHeartbeatStore } from '../store/useHeartbeatStore';
import { setSetting, getSetting } from '../db/settingsRepo';
import { StepIndicator } from '../components/StepIndicator';

const PRESETS = [
  {
    key: 'weekly',
    label: 'Weekly',
    description: 'Check in once a week',
    seconds: HEARTBEAT_INTERVALS.weekly,
    graceWeeks: 3,
  },
  {
    key: 'biweekly',
    label: 'Bi-Weekly',
    description: 'Check in every 2 weeks',
    seconds: HEARTBEAT_INTERVALS.biweekly,
    graceWeeks: 6,
  },
  {
    key: 'monthly',
    label: 'Monthly',
    description: 'Check in once a month',
    seconds: HEARTBEAT_INTERVALS.monthly,
    graceWeeks: 12,
  },
];

const SETTINGS_KEY = 'heartbeat_config';

export function HeartbeatConfigScreen() {
  const navigation = useNavigation<any>();
  const existingConfig = useHeartbeatStore((s) => s.config);
  const setConfig = useHeartbeatStore((s) => s.setConfig);

  const [selectedInterval, setSelectedInterval] = useState<number>(
    existingConfig?.intervalSeconds ?? HEARTBEAT_INTERVALS.weekly,
  );

  // Load persisted config on mount
  useEffect(() => {
    (async () => {
      const saved = await getSetting(SETTINGS_KEY);
      if (saved) {
        try {
          const parsed: HeartbeatConfig = JSON.parse(saved);
          setSelectedInterval(parsed.intervalSeconds);
        } catch {
          // Ignore corrupt data
        }
      }
    })();
  }, []);

  const selectedPreset = PRESETS.find((p) => p.seconds === selectedInterval) ?? PRESETS[0];
  const graceEstimate = selectedInterval * 3;

  const handleContinue = async () => {
    const config: HeartbeatConfig = {
      methods: ['active_tap'],
      intervalSeconds: selectedInterval,
      reminderOffsetSeconds: 3600,
    };

    setConfig(config);
    await setSetting(SETTINGS_KEY, JSON.stringify(config));
    navigation.navigate('EstateReview');
  };

  return (
    <ScrollView style={styles.container}>
      <StepIndicator currentStep={3} totalSteps={4} />

      <View style={styles.content}>
        <Text style={styles.sectionTitle}>Check-In Frequency</Text>
        <Text style={styles.sectionSubtitle}>
          How often do you want to confirm you're still in control?
        </Text>

        {PRESETS.map((preset) => {
          const isSelected = selectedInterval === preset.seconds;
          return (
            <TouchableOpacity
              key={preset.key}
              style={[styles.presetCard, isSelected && styles.presetCardSelected]}
              onPress={() => setSelectedInterval(preset.seconds)}
              activeOpacity={0.7}
            >
              <View style={styles.presetHeader}>
                <View style={[styles.radio, isSelected && styles.radioSelected]}>
                  {isSelected && <View style={styles.radioInner} />}
                </View>
                <Text style={[styles.presetLabel, isSelected && styles.presetLabelSelected]}>
                  {preset.label}
                </Text>
              </View>
              <Text style={styles.presetDescription}>{preset.description}</Text>
              <Text style={styles.presetGrace}>
                Grace period: ~{preset.graceWeeks} weeks
              </Text>
            </TouchableOpacity>
          );
        })}

        <View style={styles.summaryCard}>
          <Text style={styles.summaryTitle}>Configuration Summary</Text>
          <SummaryRow
            label="Check-in interval"
            value={formatDuration(selectedInterval)}
          />
          <SummaryRow label="Method" value="Active Tap" />
          <SummaryRow
            label="Grace period"
            value={formatDuration(graceEstimate)}
          />
        </View>

        <TouchableOpacity style={styles.continueButton} onPress={handleContinue}>
          <Text style={styles.continueButtonText}>Continue</Text>
        </TouchableOpacity>
      </View>

      <View style={{ height: SPACING.xxl }} />
    </ScrollView>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.summaryRow}>
      <Text style={styles.summaryLabel}>{label}</Text>
      <Text style={styles.summaryValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  content: {
    padding: SPACING.md,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.textPrimary,
    marginBottom: SPACING.xs,
  },
  sectionSubtitle: {
    fontSize: 14,
    color: COLORS.textSecondary,
    marginBottom: SPACING.lg,
  },
  presetCard: {
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    padding: SPACING.md,
    marginBottom: SPACING.sm,
    borderWidth: 1.5,
    borderColor: COLORS.border,
  },
  presetCardSelected: {
    borderColor: COLORS.accent,
    backgroundColor: COLORS.accent + '08',
  },
  presetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: SPACING.xs,
  },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: COLORS.textMuted,
    marginRight: SPACING.sm,
    justifyContent: 'center',
    alignItems: 'center',
  },
  radioSelected: {
    borderColor: COLORS.accent,
  },
  radioInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: COLORS.accent,
  },
  presetLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.textPrimary,
  },
  presetLabelSelected: {
    color: COLORS.accent,
  },
  presetDescription: {
    fontSize: 14,
    color: COLORS.textSecondary,
    marginLeft: 28,
  },
  presetGrace: {
    fontSize: 12,
    color: COLORS.textMuted,
    marginLeft: 28,
    marginTop: SPACING.xs,
  },
  summaryCard: {
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    padding: SPACING.md,
    marginTop: SPACING.md,
    marginBottom: SPACING.lg,
  },
  summaryTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.textPrimary,
    marginBottom: SPACING.sm,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: SPACING.xs,
  },
  summaryLabel: {
    fontSize: 14,
    color: COLORS.textSecondary,
  },
  summaryValue: {
    fontSize: 14,
    color: COLORS.textPrimary,
    fontWeight: '500',
  },
  continueButton: {
    backgroundColor: COLORS.accent,
    paddingVertical: SPACING.md,
    borderRadius: 12,
    alignItems: 'center',
  },
  continueButtonText: {
    color: COLORS.textPrimary,
    fontSize: 16,
    fontWeight: '700',
  },
});
