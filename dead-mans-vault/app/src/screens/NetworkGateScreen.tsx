import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { COLORS, FONTS } from '../utils/constants';
import type { NetworkVerification } from '../utils/rpcConfig';

interface NetworkGateScreenProps {
  verification: NetworkVerification;
  /** Re-run the genesis check. */
  onRetry: () => void;
  /** Proceed into the app despite an UNKNOWN (unverifiable) network. Only provided for the
   *  UNKNOWN state — MISMATCH is a hard block with no continue path. */
  onContinue?: () => void;
  /** True while a retry is in flight (disables the buttons + shows a spinner). */
  busy?: boolean;
}

function shortHash(h?: string | null): string {
  if (!h) return '—';
  return h.length > 18 ? `${h.slice(0, 8)}…${h.slice(-8)}` : h;
}

export function NetworkGateScreen({
  verification,
  onRetry,
  onContinue,
  busy = false,
}: NetworkGateScreenProps) {
  const isMismatch = verification.state === 'MISMATCH';

  const title = isMismatch ? 'Wrong Network' : 'Network Unverified';
  const message = isMismatch
    ? `This build expects ${verification.expectedCluster}, but the connected RPC is serving a different Solana cluster. To protect your vault, the app will not continue on the wrong network.`
    : `Couldn't reach the RPC to verify which Solana network it serves. Check your connection and retry, or switch to a different RPC in Settings.`;

  return (
    <View style={styles.center}>
      <View style={styles.card}>
        <View style={[styles.badge, isMismatch ? styles.badgeCritical : styles.badgeWarning]}>
          <Text style={[styles.badgeText, isMismatch ? styles.badgeTextCritical : styles.badgeTextWarning]}>
            {isMismatch ? 'BLOCKED' : 'UNVERIFIED'}
          </Text>
        </View>

        <Text style={styles.title}>{title}</Text>
        <Text style={styles.message}>{message}</Text>

        <View style={styles.detailRow}>
          <Text style={styles.detailLabel}>Expected</Text>
          <Text style={styles.detailValue}>{verification.expectedCluster}</Text>
        </View>
        {isMismatch && (
          <>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Expected genesis</Text>
              <Text style={styles.detailValueMono}>{shortHash(verification.expectedGenesis)}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>RPC genesis</Text>
              <Text style={styles.detailValueMono}>{shortHash(verification.receivedGenesis)}</Text>
            </View>
          </>
        )}

        {busy ? (
          <View style={styles.busyRow}>
            <ActivityIndicator size="small" color={COLORS.accent} />
            <Text style={styles.busyText}>Checking network…</Text>
          </View>
        ) : (
          <>
            <TouchableOpacity style={styles.primaryBtn} onPress={onRetry} activeOpacity={0.8}>
              <Text style={styles.primaryBtnText}>Retry</Text>
            </TouchableOpacity>
            {onContinue && (
              <TouchableOpacity style={styles.secondaryBtn} onPress={onContinue} activeOpacity={0.8}>
                <Text style={styles.secondaryBtnText}>Continue anyway</Text>
              </TouchableOpacity>
            )}
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: COLORS.bg,
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: COLORS.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 24,
    gap: 14,
  },
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
  },
  badgeCritical: {
    backgroundColor: 'rgba(239,68,68,0.12)',
    borderColor: 'rgba(239,68,68,0.4)',
  },
  badgeWarning: {
    backgroundColor: 'rgba(245,158,11,0.12)',
    borderColor: 'rgba(245,158,11,0.4)',
  },
  badgeText: {
    fontSize: 11,
    letterSpacing: 1,
    fontFamily: FONTS.primarySemiBold,
  },
  badgeTextCritical: { color: COLORS.critical },
  badgeTextWarning: { color: COLORS.warning },
  title: {
    color: COLORS.textPrimary,
    fontSize: 22,
    fontFamily: FONTS.primaryBold,
  },
  message: {
    color: COLORS.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    fontFamily: FONTS.primary,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  detailLabel: {
    color: COLORS.textMuted,
    fontSize: 12,
    fontFamily: FONTS.primary,
  },
  detailValue: {
    color: COLORS.textPrimary,
    fontSize: 13,
    fontFamily: FONTS.primaryMedium,
  },
  detailValueMono: {
    color: COLORS.textPrimary,
    fontSize: 12,
    fontFamily: FONTS.mono,
  },
  primaryBtn: {
    marginTop: 6,
    backgroundColor: COLORS.accent,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryBtnText: {
    color: COLORS.bg,
    fontSize: 15,
    fontFamily: FONTS.primarySemiBold,
  },
  secondaryBtn: {
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  secondaryBtnText: {
    color: COLORS.textSecondary,
    fontSize: 15,
    fontFamily: FONTS.primaryMedium,
  },
  busyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 14,
  },
  busyText: {
    color: COLORS.textMuted,
    fontSize: 13,
    fontFamily: FONTS.primary,
  },
});
