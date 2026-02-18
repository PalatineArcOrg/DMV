import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS, FONTS, HEARTBEAT_INTERVALS, ESCALATION_DEFAULTS } from '../utils/constants';
import { formatDuration } from '../utils/formatting';
import { HeartbeatConfig } from '../types';
import { useHeartbeatStore } from '../store/useHeartbeatStore';
import { setSetting, getSetting } from '../db/settingsRepo';
import { StepIndicator } from '../components/StepIndicator';

const ACTUAL_GRACE_DAYS = Math.round(
  (ESCALATION_DEFAULTS.stage1 + ESCALATION_DEFAULTS.stage2 + ESCALATION_DEFAULTS.stage3) / 86400,
);

const PRESETS = [
  {
    key: 'weekly',
    label: 'Weekly',
    description: 'Check in every 7 days',
    seconds: HEARTBEAT_INTERVALS.weekly,
    graceDays: ACTUAL_GRACE_DAYS,
    icon: 'clock-outline' as const,
    color: '#00FFA3',
    recommended: true,
  },
  {
    key: 'biweekly',
    label: 'Bi-Weekly',
    description: 'Check in every 14 days',
    seconds: HEARTBEAT_INTERVALS.biweekly,
    graceDays: ACTUAL_GRACE_DAYS,
    icon: 'calendar' as const,
    color: '#4DA6FF',
    recommended: false,
  },
  {
    key: 'monthly',
    label: 'Monthly',
    description: 'Check in every 30 days',
    seconds: HEARTBEAT_INTERVALS.monthly,
    graceDays: ACTUAL_GRACE_DAYS,
    icon: 'shield' as const,
    color: '#9945FF',
    recommended: false,
  },
];

const ESCALATION_TIMELINE = [
  { label: 'Reminder', color: '#F59E0B', delay: 'Day 1' },
  { label: 'Emergency', color: '#F97316', delay: 'Day 3' },
  { label: 'Final Warning', color: '#EF4444', delay: 'Day 5' },
  { label: 'Execution', color: '#DC2626', delay: 'Grace end' },
];

const SETTINGS_KEY = 'heartbeat_config';

export function HeartbeatConfigScreen() {
  const navigation = useNavigation<any>();
  const existingConfig = useHeartbeatStore((s) => s.config);
  const setConfig = useHeartbeatStore((s) => s.setConfig);

  const [selectedInterval, setSelectedInterval] = useState<number>(
    existingConfig?.intervalSeconds ?? HEARTBEAT_INTERVALS.weekly,
  );

  useEffect(() => {
    (async () => {
      const saved = await getSetting(SETTINGS_KEY);
      if (saved) {
        try {
          const parsed: HeartbeatConfig = JSON.parse(saved);
          setSelectedInterval(parsed.intervalSeconds);
        } catch { /* ignore */ }
      }
    })();
  }, []);

  const selectedPreset = PRESETS.find((p) => p.seconds === selectedInterval) ?? PRESETS[0];

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
    <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>
      <StepIndicator currentStep={3} totalSteps={4} labels={['Welcome', 'Beneficiaries', 'Heartbeat', 'Review']} />

      <View style={styles.content}>
        <Text style={styles.title}>Heartbeat Interval</Text>
        <Text style={styles.subtitle}>Choose how often you'll check in to confirm you're still in control of your vault.</Text>

        {/* Escalation info box */}
        <View style={styles.infoBox}>
          <Text style={styles.infoLabel}>HOW ESCALATION WORKS</Text>
          {ESCALATION_TIMELINE.map((item, i) => (
            <View key={i}>
              <View style={styles.timelineRow}>
                <View style={[styles.timelineDot, { backgroundColor: item.color }]} />
                <Text style={styles.timelineLabel}>{item.label}</Text>
                <View style={{ flex: 1 }} />
                <Text style={styles.timelineDelay}>{item.delay}</Text>
              </View>
              {i < ESCALATION_TIMELINE.length - 1 && <View style={styles.timelineDivider} />}
            </View>
          ))}
        </View>

        {/* Interval cards */}
        {PRESETS.map((preset) => {
          const isSelected = selectedInterval === preset.seconds;
          return (
            <TouchableOpacity
              key={preset.key}
              style={[
                styles.presetCard,
                isSelected && { backgroundColor: preset.color + '10', borderColor: preset.color, borderWidth: 1.5, shadowColor: preset.color, shadowOpacity: 0.15, shadowRadius: 16, elevation: 4 },
              ]}
              onPress={() => setSelectedInterval(preset.seconds)}
              activeOpacity={0.7}
            >
              <View style={[styles.presetIcon, { backgroundColor: isSelected ? preset.color + '15' : 'rgba(255,255,255,0.06)', borderColor: isSelected ? preset.color + '30' : 'rgba(255,255,255,0.08)' }]}>
                <MaterialCommunityIcons name={preset.icon} size={20} color={isSelected ? preset.color : 'rgba(255,255,255,0.4)'} />
              </View>
              <View style={styles.presetText}>
                <View style={styles.presetTitleRow}>
                  <Text style={[styles.presetLabel, isSelected && { color: preset.color }]}>{preset.label}</Text>
                  {preset.recommended && (
                    <View style={styles.recommendedBadge}>
                      <Text style={styles.recommendedText}>RECOMMENDED</Text>
                    </View>
                  )}
                </View>
                <Text style={styles.presetDesc}>{preset.description}</Text>
                <View style={styles.presetMeta}>
                  <Text style={styles.presetMetaText}>Interval: {preset.seconds / 86400}d</Text>
                  <Text style={styles.presetMetaDot}>{'\u00B7'}</Text>
                  <Text style={styles.presetMetaText}>Grace: {preset.graceDays}d</Text>
                </View>
              </View>
              <View style={[styles.radio, isSelected && { backgroundColor: preset.color, borderColor: preset.color }]}>
                {isSelected && <MaterialCommunityIcons name="check" size={14} color="#FFFFFF" />}
              </View>
            </TouchableOpacity>
          );
        })}

        {/* Warning */}
        <View style={styles.warningBox}>
          <Text style={styles.warningText}>
            Choose a frequency you can reliably keep. Missing heartbeats will trigger escalation toward execution.
          </Text>
        </View>

        {/* Footer */}
        <View style={styles.footer}>
          <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()}>
            <MaterialCommunityIcons name="arrow-left" size={18} color="rgba(255,255,255,0.5)" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.continueBtn} onPress={handleContinue}>
            <Text style={styles.continueBtnText}>Continue</Text>
            <MaterialCommunityIcons name="arrow-right" size={16} color={COLORS.bg} />
          </TouchableOpacity>
        </View>
      </View>

      <View style={{ height: 48 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  content: { paddingHorizontal: 16 },
  title: { fontSize: 20, fontWeight: '700', color: '#FFFFFF', fontFamily: FONTS.primaryBold, marginTop: 8 },
  subtitle: { fontSize: 13, color: 'rgba(255,255,255,0.55)', fontFamily: FONTS.primary, lineHeight: 20, marginBottom: 20 },
  infoBox: { backgroundColor: 'rgba(0,255,163,0.05)', borderWidth: 1, borderColor: 'rgba(0,255,163,0.12)', borderRadius: 12, padding: 16, marginBottom: 20 },
  infoLabel: { fontSize: 11, fontWeight: '600', color: COLORS.accent, letterSpacing: 1, marginBottom: 12, fontFamily: FONTS.primarySemiBold },
  timelineRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  timelineDot: { width: 6, height: 6, borderRadius: 3 },
  timelineLabel: { fontSize: 12, color: 'rgba(255,255,255,0.55)', fontFamily: FONTS.primary },
  timelineDelay: { fontSize: 11, color: 'rgba(255,255,255,0.25)', fontFamily: FONTS.primary },
  timelineDivider: { width: 1, height: 8, backgroundColor: 'rgba(255,255,255,0.08)', marginLeft: 3, marginVertical: 2 },
  presetCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.surface, borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)', borderRadius: 16, padding: 16, marginBottom: 12, gap: 12 },
  presetIcon: { width: 48, height: 48, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  presetText: { flex: 1 },
  presetTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  presetLabel: { fontSize: 15, fontWeight: '700', color: '#FFFFFF', fontFamily: FONTS.primaryBold },
  recommendedBadge: { borderWidth: 1, borderColor: 'rgba(0,255,163,0.3)', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1 },
  recommendedText: { fontSize: 9, fontWeight: '600', color: COLORS.accent, letterSpacing: 0.5, fontFamily: FONTS.primarySemiBold },
  presetDesc: { fontSize: 12, color: 'rgba(255,255,255,0.55)', fontFamily: FONTS.primary, marginTop: 4 },
  presetMeta: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  presetMetaText: { fontSize: 10, color: 'rgba(255,255,255,0.3)', fontFamily: FONTS.primary },
  presetMetaDot: { color: 'rgba(255,255,255,0.15)', fontSize: 10 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.15)', backgroundColor: 'rgba(255,255,255,0.06)', alignItems: 'center', justifyContent: 'center' },
  warningBox: { backgroundColor: 'rgba(245,158,11,0.06)', borderWidth: 1, borderColor: 'rgba(245,158,11,0.15)', borderRadius: 12, padding: 12, marginBottom: 24 },
  warningText: { fontSize: 11, color: '#F59E0B', lineHeight: 16, fontFamily: FONTS.primary },
  footer: { flexDirection: 'row', gap: 12, paddingHorizontal: 4 },
  backBtn: { width: 48, height: 48, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center' },
  continueBtn: { flex: 1, flexDirection: 'row', backgroundColor: COLORS.accent, borderRadius: 16, paddingVertical: 16, alignItems: 'center', justifyContent: 'center', gap: 8 },
  continueBtnText: { color: COLORS.bg, fontSize: 15, fontWeight: '700', fontFamily: FONTS.primaryBold },
});
