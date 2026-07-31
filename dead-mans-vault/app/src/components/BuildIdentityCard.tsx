import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { getRuntimeBuildIdentity } from '../config/runtimeIdentity';
import { COLORS, FONTS } from '../utils/constants';

export function BuildIdentityCard() {
  const identity = getRuntimeBuildIdentity();
  const label =
    identity.variant === 'legacy_bridge' ? 'Legacy bridge' : 'Successor';
  return (
    <View style={styles.card}>
      <Text style={styles.heading}>BUILD IDENTITY</Text>
      <Text style={styles.value}>{label} · DEVNET</Text>
      <Text style={styles.detail}>{identity.androidPackage}</Text>
      <Text style={styles.detail}>
        v{identity.version} ({identity.versionCode})
      </Text>
      <Text style={styles.warning}>
        {identity.variant === 'legacy_bridge'
          ? 'Private bridge retained for heartbeat continuity and deliberate rollback. Do not uninstall or distribute it.'
          : 'Incoming migration uses a new package-specific key. No legacy agent secret is imported and no action starts automatically.'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginBottom: 16,
    padding: 16,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
  },
  heading: {
    color: COLORS.textMuted,
    fontFamily: FONTS.primarySemiBold,
    fontSize: 11,
    letterSpacing: 1,
  },
  value: {
    color: COLORS.accent,
    fontFamily: FONTS.primarySemiBold,
    fontSize: 14,
    marginTop: 8,
  },
  detail: {
    color: COLORS.textSecondary,
    fontFamily: FONTS.mono,
    fontSize: 12,
    marginTop: 4,
  },
  warning: {
    color: COLORS.warning,
    fontFamily: FONTS.primary,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 8,
  },
});
