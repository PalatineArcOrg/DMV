import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useWallet } from '../hooks/useWallet';
import { useVaultStore } from '../store/useVaultStore';
import { PortfolioScanner } from '../services/PortfolioScanner';
import { DeFiPosition, DeFiPositionAction } from '../types/defi';
import { RPC_URL, HELIUS_API_KEY, COLORS, SPACING } from '../utils/constants';

const ACTIONS: DeFiPositionAction[] = ['close', 'transfer', 'ignore'];

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
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>DeFi Positions</Text>
      <Text style={styles.subtitle}>
        {positions.length === 0
          ? 'No DeFi positions detected.'
          : 'Choose an action for each position during estate execution.'}
      </Text>

      {positions.map((pos, i) => (
        <View key={i} style={styles.positionCard}>
          <Text style={styles.positionProtocol}>
            {pos.protocol.replace('_', ' ').toUpperCase()}
          </Text>
          <Text style={styles.positionType}>{pos.type}</Text>
          <Text style={styles.positionDesc}>{pos.description}</Text>

          {pos.estimatedValueSol > 0 && (
            <Text style={styles.positionValue}>
              ~{pos.estimatedValueSol.toFixed(4)} SOL
            </Text>
          )}

          <View style={styles.actionRow}>
            {ACTIONS.map((action) => (
              <TouchableOpacity
                key={action}
                style={[
                  styles.actionButton,
                  pos.action === action && styles.actionButtonActive,
                ]}
                onPress={() => updateAction(i, action)}
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
      ))}

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
    color: COLORS.textSecondary,
    marginTop: SPACING.md,
    fontSize: 14,
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
  },
  positionCard: {
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    padding: SPACING.md,
    marginBottom: SPACING.md,
  },
  positionProtocol: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.accent,
    marginBottom: 4,
  },
  positionType: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.textPrimary,
  },
  positionDesc: {
    fontSize: 13,
    color: COLORS.textSecondary,
    marginTop: 4,
  },
  positionValue: {
    fontSize: 14,
    color: COLORS.textPrimary,
    fontWeight: '500',
    marginTop: SPACING.sm,
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
