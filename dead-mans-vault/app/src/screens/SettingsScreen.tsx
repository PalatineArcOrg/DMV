import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useWallet } from '../hooks/useWallet';
import { COLORS, SPACING, PROGRAM_ID, RPC_URL } from '../utils/constants';
import { truncateAddress } from '../utils/formatting';

export function SettingsScreen() {
  const { publicKey, connected, connect, disconnect } = useWallet();

  return (
    <View style={styles.container}>
      <Text style={styles.header}>Settings</Text>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Wallet</Text>
        {connected && publicKey ? (
          <>
            <SettingRow
              label="Address"
              value={truncateAddress(publicKey.toString(), 8)}
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
        <Text style={styles.cardTitle}>Network</Text>
        <SettingRow label="RPC" value={RPC_URL} />
        <SettingRow label="Program ID" value={truncateAddress(PROGRAM_ID, 6)} />
        <SettingRow label="Network" value="Devnet" />
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>About</Text>
        <SettingRow label="App" value="Dead Man's Vault" />
        <SettingRow label="Version" value="0.1.0" />
      </View>
    </View>
  );
}

function SettingRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.settingRow}>
      <Text style={styles.settingLabel}>{label}</Text>
      <Text style={styles.settingValue} numberOfLines={1}>
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
