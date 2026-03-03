import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useWallet } from '../hooks/useWallet';
import { useVaultStore } from '../store/useVaultStore';
import { usePortfolioStore } from '../store/usePortfolioStore';
import { PortfolioScanner } from '../services/PortfolioScanner';
import { DeFiPosition, DeFiPositionAction, ClosureStrategy } from '../types/defi';
import { saveDefiPositions } from '../db/defiPositionRepo';
import { RPC_URL, HELIUS_API_KEY, COLORS, SPACING, FONTS } from '../utils/constants';
import { StepIndicator } from '../components/StepIndicator';

const ACTIONS: DeFiPositionAction[] = ['close', 'transfer', 'ignore'];

const PROTOCOL_ICONS: Record<string, keyof typeof MaterialIcons.glyphMap> = {
  marinade: 'water-drop',
  jito: 'bolt',
  sanctum: 'verified',
  kamino: 'account-balance',
  jupiter: 'swap-horiz',
  raydium: 'blur-circular',
  orca: 'waves',
  meteora: 'auto-awesome',
  marginfi: 'trending-up',
  native_stake: 'lock',
};

const STRATEGY_LABELS: Record<ClosureStrategy, string> = {
  jupiter_swap: 'Swap to SOL via Jupiter',
  protocol_native: 'Protocol-specific closure',
  unsupported: 'Detection only',
};

const STRATEGY_COLORS: Record<ClosureStrategy, string> = {
  jupiter_swap: COLORS.accent,
  protocol_native: COLORS.warning,
  unsupported: COLORS.textMuted,
};

// --- Tier classification ---
// Tier 1 (Depositable): liquid tokens that can be swapped to SOL
// Tier 2 (Reassignable): native stake accounts — withdraw authority can be reassigned
// Tier 3 (Unrecoverable): locked positions requiring owner signature to close

type PositionTier = 1 | 2 | 3;

const UNRECOVERABLE_PROTOCOLS: Set<string> = new Set([
  'orca', 'raydium', 'meteora', 'marginfi', 'kamino',
]);

function classifyTier(pos: DeFiPosition): PositionTier {
  if (pos.protocol === 'native_stake') return 2;
  if (pos.closureStrategy === 'unsupported' || UNRECOVERABLE_PROTOCOLS.has(pos.protocol)) return 3;
  return 1;
}

const TIER_LABELS: Record<PositionTier, string> = {
  1: 'DEPOSITABLE',
  2: 'REASSIGNABLE',
  3: 'REQUIRES MANUAL ACTION',
};

const TIER_COLORS: Record<PositionTier, string> = {
  1: COLORS.accent,
  2: COLORS.warning,
  3: COLORS.critical,
};

export function DeFiPositionsScreen() {
  const navigation = useNavigation<any>();
  const { publicKey } = useWallet();
  const { setDefiPositions } = useVaultStore();

  const [positions, setPositions] = useState<DeFiPosition[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [reviewed, setReviewed] = useState(false);

  useEffect(() => {
    if (!publicKey) return;

    // Read from Zustand store first (avoids duplicate 100-credit Enhanced TX call)
    const storePositions = usePortfolioStore.getState().defiPositions;
    if (storePositions.length > 0) {
      setPositions(storePositions);
      setIsLoading(false);
      return;
    }

    // Only scan fresh if store is empty (first app launch / no prior refresh)
    const scanner = new PortfolioScanner(RPC_URL, HELIUS_API_KEY);
    scanner
      .detectDeFiPositions(publicKey)
      .then((detected) => {
        setPositions(detected);
        if (detected.length === 0) setReviewed(true);
      })
      .catch(() => {
        setReviewed(true);
      })
      .finally(() => setIsLoading(false));
  }, [publicKey]);

  const updateAction = useCallback(
    (index: number, action: DeFiPositionAction) => {
      setPositions((prev) => {
        const updated = [...prev];
        updated[index] = { ...updated[index], action };
        return updated;
      });
      setReviewed(true);
    },
    [],
  );

  const handleContinue = useCallback(async () => {
    setDefiPositions(positions);
    if (publicKey) {
      await saveDefiPositions(publicKey.toString(), positions);
    }
    navigation.navigate('EstateReview');
  }, [positions, setDefiPositions, publicKey, navigation]);

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={COLORS.accent} />
        <Text style={styles.loadingText}>Scanning DeFi positions...</Text>
        <Text style={styles.loadingSubtext}>
          Checking 10 protocols across your wallet
        </Text>
      </View>
    );
  }

  // Group positions by protocol
  const grouped = positions.reduce<Record<string, DeFiPosition[]>>((acc, pos) => {
    const key = pos.protocol;
    if (!acc[key]) acc[key] = [];
    acc[key].push(pos);
    return acc;
  }, {});

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <StepIndicator currentStep={3} totalSteps={4} />

      <Text style={styles.title}>DeFi Positions</Text>
      <Text style={styles.subtitle}>
        {positions.length === 0
          ? 'No DeFi positions detected in your wallet.'
          : `Found ${positions.length} position${positions.length > 1 ? 's' : ''} across ${Object.keys(grouped).length} protocol${Object.keys(grouped).length > 1 ? 's' : ''}. Choose an action for each.`}
      </Text>

      {/* Tier 3 (Unrecoverable) warning banner */}
      {positions.some((p) => classifyTier(p) === 3) && (
        <View style={styles.tierWarningBanner}>
          <MaterialIcons name="warning" size={18} color={COLORS.critical} />
          <View style={{ flex: 1 }}>
            <Text style={styles.tierWarningTitle}>Unrecoverable Positions Detected</Text>
            <Text style={styles.tierWarningText}>
              Some positions (concentrated liquidity, lending, perps) are locked to your wallet signature and cannot be automatically distributed. Close or withdraw these manually before they become inaccessible.
            </Text>
          </View>
        </View>
      )}

      {Object.entries(grouped).map(([protocol, protocolPositions]) => (
        <View key={protocol} style={styles.protocolGroup}>
          <View style={styles.protocolHeader}>
            <MaterialIcons
              name={PROTOCOL_ICONS[protocol] || 'code'}
              size={18}
              color={COLORS.accent}
            />
            <Text style={styles.protocolName}>
              {protocol.replace('_', ' ').toUpperCase()}
            </Text>
            <Text style={styles.protocolCount}>
              {protocolPositions.length}
            </Text>
          </View>

          {protocolPositions.map((pos, i) => {
            const globalIndex = positions.indexOf(pos);
            return (
              <View key={i} style={styles.positionCard}>
                <View style={styles.positionHeader}>
                  <Text style={styles.positionType}>{pos.type.replace('_', ' ')}</Text>
                  <View style={{ flexDirection: 'row', gap: 6 }}>
                    <View
                      style={[
                        styles.strategyBadge,
                        { backgroundColor: TIER_COLORS[classifyTier(pos)] + '15' },
                      ]}
                    >
                      <Text
                        style={[styles.strategyText, { color: TIER_COLORS[classifyTier(pos)] }]}
                      >
                        {TIER_LABELS[classifyTier(pos)]}
                      </Text>
                    </View>
                    <View
                      style={[
                        styles.strategyBadge,
                        { backgroundColor: STRATEGY_COLORS[pos.closureStrategy] + '20' },
                      ]}
                    >
                      <Text
                        style={[
                          styles.strategyText,
                          { color: STRATEGY_COLORS[pos.closureStrategy] },
                        ]}
                      >
                        {pos.closureStrategy === 'jupiter_swap'
                          ? 'Jupiter Swap'
                          : pos.closureStrategy === 'protocol_native'
                            ? 'Native Close'
                            : 'Detect Only'}
                      </Text>
                    </View>
                  </View>
                </View>

                <Text style={styles.positionDesc}>{pos.description}</Text>

                <View style={styles.positionMeta}>
                  {pos.estimatedValueSol > 0 && (
                    <Text style={styles.positionValue}>
                      ~{pos.estimatedValueSol.toFixed(4)} SOL
                    </Text>
                  )}
                  {pos.estimatedValueUsd > 0 && (
                    <Text style={styles.positionUsd}>
                      ${pos.estimatedValueUsd.toFixed(2)}
                    </Text>
                  )}
                  {pos.tokenMint && (
                    <Text style={styles.positionMint}>
                      {pos.tokenMint.slice(0, 6)}...{pos.tokenMint.slice(-4)}
                    </Text>
                  )}
                </View>

                <Text style={styles.strategyLabel}>
                  {STRATEGY_LABELS[pos.closureStrategy]}
                </Text>

                <View style={styles.actionRow}>
                  {ACTIONS.map((action) => (
                    <TouchableOpacity
                      key={action}
                      style={[
                        styles.actionButton,
                        pos.action === action && styles.actionButtonActive,
                      ]}
                      onPress={() => updateAction(globalIndex, action)}
                    >
                      <Text
                        style={[
                          styles.actionText,
                          pos.action === action && styles.actionTextActive,
                        ]}
                      >
                        {action.charAt(0).toUpperCase() + action.slice(1)}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            );
          })}
        </View>
      ))}

      {positions.length === 0 && (
        <View style={styles.emptyCard}>
          <MaterialIcons name="search-off" size={48} color={COLORS.textMuted} />
          <Text style={styles.emptyTitle}>No Positions Found</Text>
          <Text style={styles.emptyDesc}>
            Your wallet has no active DeFi positions. Native SOL and SPL tokens
            will be distributed directly to beneficiaries.
          </Text>
        </View>
      )}

      <TouchableOpacity
        style={[styles.continueButton, !reviewed && styles.continueDisabled]}
        onPress={handleContinue}
        disabled={!reviewed}
      >
        <Text style={styles.continueButtonText}>Continue</Text>
      </TouchableOpacity>

      <View style={{ height: SPACING.xxl }} />
    </ScrollView>
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
  center: {
    flex: 1,
    backgroundColor: COLORS.bg,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    color: COLORS.textPrimary,
    marginTop: SPACING.md,
    fontSize: 16,
    fontWeight: '600',
  },
  loadingSubtext: {
    color: COLORS.textSecondary,
    marginTop: SPACING.xs,
    fontSize: 13,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: COLORS.textPrimary,
    marginBottom: SPACING.xs,
  },
  subtitle: {
    fontSize: 14,
    color: COLORS.textSecondary,
    marginBottom: SPACING.lg,
    lineHeight: 20,
  },
  protocolGroup: {
    marginBottom: SPACING.md,
  },
  protocolHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: SPACING.sm,
    gap: SPACING.sm,
  },
  protocolName: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.textPrimary,
    letterSpacing: 0.5,
    flex: 1,
  },
  protocolCount: {
    fontSize: 12,
    color: COLORS.textMuted,
    fontFamily: FONTS.mono,
  },
  positionCard: {
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    padding: SPACING.md,
    marginBottom: SPACING.sm,
  },
  positionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.xs,
  },
  positionType: {
    fontSize: 15,
    fontWeight: '600',
    color: COLORS.textPrimary,
    textTransform: 'capitalize',
  },
  strategyBadge: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: 2,
    borderRadius: 6,
  },
  strategyText: {
    fontSize: 11,
    fontWeight: '600',
  },
  positionDesc: {
    fontSize: 13,
    color: COLORS.textSecondary,
    marginTop: 2,
    lineHeight: 18,
  },
  positionMeta: {
    flexDirection: 'row',
    gap: SPACING.md,
    marginTop: SPACING.sm,
  },
  positionValue: {
    fontSize: 14,
    color: COLORS.textPrimary,
    fontWeight: '600',
    fontFamily: FONTS.mono,
  },
  positionUsd: {
    fontSize: 14,
    color: COLORS.textSecondary,
    fontFamily: FONTS.mono,
  },
  positionMint: {
    fontSize: 12,
    color: COLORS.textMuted,
    fontFamily: FONTS.mono,
  },
  strategyLabel: {
    fontSize: 12,
    color: COLORS.textMuted,
    marginTop: SPACING.sm,
    fontStyle: 'italic',
  },
  actionRow: {
    flexDirection: 'row',
    gap: SPACING.sm,
    marginTop: SPACING.md,
  },
  actionButton: {
    flex: 1,
    paddingVertical: SPACING.sm,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
  },
  actionButtonActive: {
    borderColor: COLORS.accent,
    backgroundColor: COLORS.accent + '20',
  },
  actionText: {
    fontSize: 13,
    color: COLORS.textMuted,
  },
  actionTextActive: {
    color: COLORS.accent,
    fontWeight: '600',
  },
  emptyCard: {
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    padding: SPACING.lg,
    alignItems: 'center',
    marginBottom: SPACING.md,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.textPrimary,
    marginTop: SPACING.md,
  },
  emptyDesc: {
    fontSize: 13,
    color: COLORS.textSecondary,
    textAlign: 'center',
    marginTop: SPACING.sm,
    lineHeight: 18,
  },
  continueButton: {
    backgroundColor: COLORS.healthy,
    borderRadius: 12,
    paddingVertical: SPACING.md,
    alignItems: 'center',
    marginTop: SPACING.md,
  },
  continueDisabled: {
    opacity: 0.4,
  },
  continueButtonText: {
    color: COLORS.bg,
    fontSize: 16,
    fontWeight: '700',
  },
  tierWarningBanner: {
    flexDirection: 'row',
    gap: SPACING.sm,
    backgroundColor: 'rgba(239,68,68,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.25)',
    borderRadius: 12,
    padding: SPACING.md,
    marginBottom: SPACING.md,
  },
  tierWarningTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.critical,
    fontFamily: FONTS.primaryBold,
    marginBottom: 4,
  },
  tierWarningText: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.55)',
    fontFamily: FONTS.primary,
    lineHeight: 18,
  },
});
