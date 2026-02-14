import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { COLORS, SPACING, HEARTBEAT_INTERVALS } from '../utils/constants';
import { formatDuration } from '../utils/formatting';
import { HeartbeatMethod, HeartbeatConfig } from '../types';
import { useHeartbeatStore } from '../store/useHeartbeatStore';
import { setSetting, getSetting } from '../db/settingsRepo';

const METHODS: { key: HeartbeatMethod; label: string; description: string }[] = [
  {
    key: 'active_tap',
    label: 'Active Tap',
    description: 'Manually confirm by tapping the heartbeat button',
  },
  {
    key: 'biometric_confirm',
    label: 'Biometric',
    description: 'Confirm using fingerprint or face recognition',
  },
  {
    key: 'on_chain_activity',
    label: 'On-Chain Activity',
    description: 'Any wallet transaction counts as a heartbeat',
  },
  {
    key: 'pin_challenge',
    label: 'PIN Challenge',
    description: 'Enter a PIN code to confirm liveness',
  },
  {
    key: 'hardware_switch',
    label: 'Hardware Switch',
    description: 'Physical button press on Seeker device',
  },
];

const INTERVAL_OPTIONS: { key: string; label: string; seconds: number }[] = [
  { key: 'daily', label: 'Daily', seconds: HEARTBEAT_INTERVALS.daily },
  { key: 'weekly', label: 'Weekly', seconds: HEARTBEAT_INTERVALS.weekly },
  { key: 'biweekly', label: 'Biweekly', seconds: HEARTBEAT_INTERVALS.biweekly },
  { key: 'monthly', label: 'Monthly', seconds: HEARTBEAT_INTERVALS.monthly },
];

const SETTINGS_KEY = 'heartbeat_config';

export function HeartbeatConfigScreen() {
  const existingConfig = useHeartbeatStore((s) => s.config);
  const setConfig = useHeartbeatStore((s) => s.setConfig);

  const [selectedMethods, setSelectedMethods] = useState<HeartbeatMethod[]>(
    existingConfig?.methods ?? ['active_tap'],
  );
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
          setSelectedMethods(parsed.methods);
          setSelectedInterval(parsed.intervalSeconds);
        } catch {
          // Ignore corrupt data
        }
      }
    })();
  }, []);

  const toggleMethod = (method: HeartbeatMethod) => {
    if (method === 'active_tap') return; // Always required
    setSelectedMethods((prev) =>
      prev.includes(method)
        ? prev.filter((m) => m !== method)
        : [...prev, method],
    );
  };

  const handleSave = async () => {
    const config: HeartbeatConfig = {
      methods: selectedMethods,
      intervalSeconds: selectedInterval,
      reminderOffsetSeconds: 3600,
    };

    setConfig(config);
    await setSetting(SETTINGS_KEY, JSON.stringify(config));
    Alert.alert('Saved', 'Heartbeat configuration updated.');
  };

  const graceEstimate = selectedInterval * 3; // Rough estimate: 3x interval

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.sectionTitle}>Heartbeat Methods</Text>
      <Text style={styles.sectionSubtitle}>
        Select how you want to confirm liveness
      </Text>

      {METHODS.map((method) => {
        const isSelected = selectedMethods.includes(method.key);
        const isRequired = method.key === 'active_tap';
        return (
          <TouchableOpacity
            key={method.key}
            style={[styles.methodCard, isSelected && styles.methodCardSelected]}
            onPress={() => toggleMethod(method.key)}
            activeOpacity={isRequired ? 1 : 0.7}
          >
            <View style={styles.methodHeader}>
              <View
                style={[
                  styles.checkbox,
                  isSelected && styles.checkboxSelected,
                ]}
              >
                {isSelected && <Text style={styles.checkmark}>&#10003;</Text>}
              </View>
              <Text style={styles.methodLabel}>
                {method.label}
                {isRequired ? ' (Required)' : ''}
              </Text>
            </View>
            <Text style={styles.methodDescription}>{method.description}</Text>
          </TouchableOpacity>
        );
      })}

      <Text style={[styles.sectionTitle, { marginTop: SPACING.lg }]}>
        Check-In Interval
      </Text>
      <Text style={styles.sectionSubtitle}>
        How often you need to confirm liveness
      </Text>

      <View style={styles.intervalRow}>
        {INTERVAL_OPTIONS.map((opt) => (
          <TouchableOpacity
            key={opt.key}
            style={[
              styles.intervalButton,
              selectedInterval === opt.seconds && styles.intervalButtonSelected,
            ]}
            onPress={() => setSelectedInterval(opt.seconds)}
          >
            <Text
              style={[
                styles.intervalLabel,
                selectedInterval === opt.seconds && styles.intervalLabelSelected,
              ]}
            >
              {opt.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.summaryCard}>
        <Text style={styles.summaryTitle}>Configuration Summary</Text>
        <SummaryRow
          label="Check-in interval"
          value={formatDuration(selectedInterval)}
        />
        <SummaryRow
          label="Methods enabled"
          value={String(selectedMethods.length)}
        />
        <SummaryRow
          label="Est. grace period"
          value={formatDuration(graceEstimate)}
        />
      </View>

      <TouchableOpacity style={styles.saveButton} onPress={handleSave}>
        <Text style={styles.saveButtonText}>Save Configuration</Text>
      </TouchableOpacity>

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
    marginBottom: SPACING.md,
  },
  methodCard: {
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    padding: SPACING.md,
    marginBottom: SPACING.sm,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  methodCardSelected: {
    borderColor: COLORS.accent,
  },
  methodHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: SPACING.xs,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: COLORS.textMuted,
    marginRight: SPACING.sm,
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkboxSelected: {
    borderColor: COLORS.accent,
    backgroundColor: COLORS.accent,
  },
  checkmark: {
    color: COLORS.textPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  methodLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: COLORS.textPrimary,
  },
  methodDescription: {
    fontSize: 13,
    color: COLORS.textSecondary,
    marginLeft: 30,
  },
  intervalRow: {
    flexDirection: 'row',
    gap: SPACING.sm,
    marginBottom: SPACING.lg,
  },
  intervalButton: {
    flex: 1,
    paddingVertical: SPACING.sm,
    borderRadius: 8,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
  },
  intervalButtonSelected: {
    borderColor: COLORS.accent,
    backgroundColor: COLORS.accent + '20',
  },
  intervalLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.textSecondary,
  },
  intervalLabelSelected: {
    color: COLORS.accent,
  },
  summaryCard: {
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    padding: SPACING.md,
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
  saveButton: {
    backgroundColor: COLORS.accent,
    paddingVertical: SPACING.md,
    borderRadius: 12,
    alignItems: 'center',
  },
  saveButtonText: {
    color: COLORS.textPrimary,
    fontSize: 16,
    fontWeight: '700',
  },
});
