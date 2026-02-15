import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { useWallet } from '../hooks/useWallet';
import { useDemoStore } from '../store/useDemoStore';
import { COLORS, SPACING, PROGRAM_ID, RPC_URL, FONTS } from '../utils/constants';
import { truncateAddress } from '../utils/formatting';
import appJson from '../../app.json';

export function SettingsScreen() {
  const { publicKey, connected, connect, disconnect } = useWallet();
  const { isDemoMode, setDemoMode, incrementTap } = useDemoStore();

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.header}>Settings</Text>

      {isDemoMode && (
        <View style={styles.demoBadge}>
          <Text style={styles.demoBadgeText}>DEMO MODE ACTIVE</Text>
        </View>
      )}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Wallet</Text>
        {connected && publicKey ? (
          <>
            <SettingRow
              label="Address"
              value={truncateAddress(publicKey.toString(), 8)}
              mono
            />
            <TouchableOpacity
              style={styles.disconnectButton}
              onPress={disconnect}
            >
              <Text style={styles.disconnectText}>Disconnect</Text>
            </TouchableOpacity>
          </>
        ) : (
          <TouchableOpacity style={styles.connectButton} onPress={connect}>
            <Text style={styles.connectText}>Connect Wallet</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Demo Mode</Text>
        <Text style={styles.demoDescription}>
          Use fast timers (30s stages) for testing escalation and execution flows.
        </Text>
        <TouchableOpacity
          style={[styles.demoToggle, isDemoMode && styles.demoToggleActive]}
          onPress={() => setDemoMode(!isDemoMode)}
        >
          <Text style={[styles.demoToggleText, isDemoMode && styles.demoToggleTextActive]}>
            {isDemoMode ? 'Disable Demo Mode' : 'Enable Demo Mode'}
          </Text>
        </TouchableOpacity>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Network</Text>
        <SettingRow label="RPC" value={RPC_URL} mono />
        <SettingRow label="Program ID" value={truncateAddress(PROGRAM_ID, 6)} mono />
        <SettingRow label="Network" value="Devnet" />
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>About</Text>
        <SettingRow label="App" value="Dead Man's Vault" />
        <TouchableOpacity onPress={incrementTap} activeOpacity={0.7}>
          <SettingRow label="Version" value={appJson.expo.version} />
        </TouchableOpacity>
      </View>

      <View style={{ height: SPACING.xxl }} />
    </ScrollView>
  );
}

function SettingRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.settingRow}>
      <Text style={styles.settingLabel}>{label}</Text>
      <Text
        style={[styles.settingValue, mono && { fontFamily: FONTS.mono }]}
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
    padding: SPACING.md,
  },
  header: {
    fontSize: 24,
    fontWeight: '700',
    color: COLORS.textPrimary,
    marginBottom: SPACING.lg,
    marginTop: SPACING.md,
  },
  demoBadge: {
    backgroundColor: COLORS.accent + '20',
    borderWidth: 1,
    borderColor: COLORS.accent,
    borderRadius: 8,
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.md,
    alignSelf: 'flex-start',
    marginBottom: SPACING.md,
  },
  demoBadgeText: {
    color: COLORS.accent,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
  },
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    padding: SPACING.md,
    marginBottom: SPACING.md,
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: SPACING.sm,
  },
  demoDescription: {
    fontSize: 13,
    color: COLORS.textSecondary,
    marginBottom: SPACING.sm,
    lineHeight: 18,
  },
  demoToggle: {
    backgroundColor: COLORS.surfaceHover,
    borderWidth: 1,
    borderColor: COLORS.borderLight,
    paddingVertical: SPACING.sm,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: SPACING.xs,
  },
  demoToggleActive: {
    backgroundColor: COLORS.accent + '20',
    borderColor: COLORS.accent,
  },
  demoToggleText: {
    color: COLORS.textSecondary,
    fontWeight: '600',
    fontSize: 14,
  },
  demoToggleTextActive: {
    color: COLORS.accent,
  },
  settingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: SPACING.sm,
  },
  settingLabel: {
    fontSize: 14,
    color: COLORS.textSecondary,
  },
  settingValue: {
    fontSize: 14,
    color: COLORS.textPrimary,
    fontWeight: '500',
    maxWidth: '60%',
  },
  connectButton: {
    backgroundColor: COLORS.accent,
    paddingVertical: SPACING.sm,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: SPACING.sm,
  },
  connectText: {
    color: COLORS.textPrimary,
    fontWeight: '600',
    fontSize: 14,
  },
  disconnectButton: {
    backgroundColor: COLORS.critical + '20',
    borderWidth: 1,
    borderColor: COLORS.critical,
    paddingVertical: SPACING.sm,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: SPACING.sm,
  },
  disconnectText: {
    color: COLORS.critical,
    fontWeight: '600',
    fontSize: 14,
  },
});
