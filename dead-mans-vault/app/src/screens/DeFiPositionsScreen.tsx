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
import { PortfolioScanner } from '../services/PortfolioScanner';
import { DeFiPosition, DeFiPositionAction, ClosureStrategy } from '../types/defi';
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

export function DeFiPositionsScreen() {
  const navigation = useNavigation<any>();
  const { publicKey } = useWallet();
  const { setDefiPositions } = useVaultStore();

  const [positions, setPositions] = useState<DeFiPosition[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [reviewed, setReviewed] = useState(false);

  useEffect(() => {
    if (!publicKey) return;

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

  const handleContinue = useCallback(() => {
    setDefiPositions(positions);
    navigation.navigate('EstateReview');
  }, [positions, setDefiPositions, navigation]);

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
    color: COLORS.textPrimary,
    fontSize: 16,
    fontWeight: '700',
  },
});
