import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Image,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useWallet } from '../hooks/useWallet';
import { usePortfolio } from '../hooks/usePortfolio';
import { useVaultStore } from '../store/useVaultStore';
import { DeFiPosition, DeFiPositionAction } from '../types/defi';
import { COLORS, SPACING, FONTS, TOKEN_COLORS } from '../utils/constants';
import { formatUsd, formatTokenAmount } from '../utils/formatting';

type Tab = 'tokens' | 'defi';

const PROTOCOL_ICONS: Record<string, keyof typeof MaterialCommunityIcons.glyphMap> = {
  marinade: 'water',
  jito: 'lightning-bolt',
  sanctum: 'check-decagram',
  kamino: 'bank',
  jupiter: 'swap-horizontal',
  raydium: 'circle-outline',
  orca: 'waves',
  meteora: 'star-four-points',
  marginfi: 'trending-up',
  native_stake: 'lock',
};

const ACTIONS: DeFiPositionAction[] = ['close', 'transfer', 'ignore'];

function TokenIcon({ symbol, logoUri }: { symbol: string; logoUri?: string | null }) {
  const color = TOKEN_COLORS[symbol] || COLORS.accent;
  if (logoUri) {
    return (
      <View style={[styles.tokenIcon, { backgroundColor: color + '22', borderColor: color + '44' }]}>
        <Image source={{ uri: logoUri }} style={styles.tokenIconImage} />
      </View>
    );
  }
  return (
    <View style={[styles.tokenIcon, { backgroundColor: color + '22', borderColor: color + '44' }]}>
      <Text style={[styles.tokenIconText, { color }]}>{symbol.slice(0, 3)}</Text>
    </View>
  );
}

export function AssetsScreen() {
  const { publicKey, connected } = useWallet();
  const { balances, defiPositions: portfolioDefiPositions, totalUsdValue, isLoading: portfolioLoading, refresh } = usePortfolio();
  const isSetupComplete = useVaultStore((s) => s.isSetupComplete);

  const [activeTab, setActiveTab] = useState<Tab>('tokens');
  const [positions, setPositions] = useState<DeFiPosition[]>([]);

  // Sync DeFi positions from usePortfolio
  useEffect(() => {
    if (portfolioDefiPositions.length > 0) {
      setPositions(portfolioDefiPositions);
    }
  }, [portfolioDefiPositions]);

  // Auto-refresh tokens + DeFi on screen focus if not yet loaded
  useFocusEffect(
    useCallback(() => {
      if (connected && publicKey && balances.length === 0 && !portfolioLoading) {
        refresh();
      }
    }, [connected, publicKey, balances.length, portfolioLoading, refresh]),
  );

  const updateAction = useCallback((index: number, action: DeFiPositionAction) => {
    setPositions((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], action };
      return updated;
    });
  }, []);

  const onRefresh = useCallback(async () => {
    await refresh();
  }, [refresh]);

  if (!connected) {
    return (
      <View style={styles.center}>
        <MaterialCommunityIcons name="wallet-outline" size={40} color={COLORS.textMuted} />
        <Text style={styles.emptyTitle}>Connect Wallet</Text>
        <Text style={styles.emptyDesc}>Connect your wallet to view assets.</Text>
      </View>
    );
  }

  // Group DeFi positions by protocol
  const grouped = positions.reduce<Record<string, DeFiPosition[]>>((acc, pos) => {
    const key = pos.protocol;
    if (!acc[key]) acc[key] = [];
    acc[key].push(pos);
    return acc;
  }, {});

  return (
    <ScrollView
      style={styles.container}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl refreshing={portfolioLoading} onRefresh={onRefresh} tintColor={COLORS.accent} />
      }
    >
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Your Assets</Text>
        <Text style={styles.headerValue}>{formatUsd(totalUsdValue)}</Text>
      </View>

      {/* Vault Protection Status */}
      {isSetupComplete ? (
        <View style={styles.protectionBadge}>
          <MaterialCommunityIcons name="shield-check" size={14} color={COLORS.accent} />
          <Text style={styles.protectionText}>Vault Protected</Text>
        </View>
      ) : (
        <View style={styles.unprotectedBadge}>
          <MaterialCommunityIcons name="shield-off" size={14} color={COLORS.warning} />
          <Text style={styles.unprotectedText}>Not Protected</Text>
        </View>
      )}

      {/* Segment Tabs */}
      <View style={styles.segmentContainer}>
        <TouchableOpacity
          style={[styles.segmentTab, activeTab === 'tokens' && styles.segmentTabActive]}
          onPress={() => setActiveTab('tokens')}
        >
          <Text style={[styles.segmentText, activeTab === 'tokens' && styles.segmentTextActive]}>
            Tokens ({balances.length})
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.segmentTab, activeTab === 'defi' && styles.segmentTabActive]}
          onPress={() => setActiveTab('defi')}
        >
          <Text style={[styles.segmentText, activeTab === 'defi' && styles.segmentTextActive]}>
            DeFi ({positions.length})
          </Text>
        </TouchableOpacity>
      </View>

      {/* Tokens View */}
      {activeTab === 'tokens' && (
        <View style={styles.card}>
          {portfolioLoading && balances.length === 0 ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color={COLORS.accent} />
              <Text style={styles.loadingText}>Loading tokens...</Text>
            </View>
          ) : balances.length === 0 ? (
            <View style={styles.emptyCard}>
              <MaterialCommunityIcons name="currency-usd" size={36} color={COLORS.textMuted} />
              <Text style={styles.emptyTitle}>No Tokens</Text>
              <Text style={styles.emptyDesc}>No tokens found in this wallet.</Text>
            </View>
          ) : (
            balances.map((token, i) => (
              <View key={i} style={[styles.tokenRow, i < balances.length - 1 && styles.tokenRowBorder]}>
                <TokenIcon symbol={token.symbol} logoUri={token.logoUri} />
                <View style={styles.tokenInfo}>
                  <View style={styles.tokenNameRow}>
                    <Text style={styles.tokenSymbol}>{token.symbol}</Text>
                    {isSetupComplete && (
                      <MaterialCommunityIcons name="shield-check" size={12} color={COLORS.accent} style={{ marginLeft: 4 }} />
                    )}
                  </View>
                  <Text style={styles.tokenAmount}>
                    {formatTokenAmount(token.amount, token.decimals > 4 ? 4 : token.decimals)} {token.symbol}
                  </Text>
                </View>
                <View style={styles.tokenRight}>
                  {token.usdValue > 0 && (
                    <Text style={styles.tokenUsd}>{formatUsd(token.usdValue)}</Text>
                  )}
                  {token.change24h != null && (
                    <Text style={[styles.tokenChange, { color: token.change24h >= 0 ? COLORS.accent : COLORS.critical }]}>
                      {token.change24h >= 0 ? '+' : ''}{token.change24h.toFixed(1)}%
                    </Text>
                  )}
                </View>
              </View>
            ))
          )}
        </View>
      )}

      {/* DeFi View */}
      {activeTab === 'defi' && (
        <View>
          {portfolioLoading && positions.length === 0 ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color={COLORS.accent} />
              <Text style={styles.loadingText}>Scanning DeFi positions...</Text>
              <Text style={styles.loadingSubtext}>Checking 10 protocols</Text>
            </View>
          ) : positions.length === 0 ? (
            <View style={[styles.card, styles.emptyCard]}>
              <MaterialCommunityIcons name="magnify-close" size={36} color={COLORS.textMuted} />
              <Text style={styles.emptyTitle}>No Positions Found</Text>
              <Text style={styles.emptyDesc}>
                No active DeFi positions detected.
              </Text>
            </View>
          ) : (
            Object.entries(grouped).map(([protocol, protocolPositions]) => (
              <View key={protocol} style={styles.protocolGroup}>
                <View style={styles.protocolHeader}>
                  <MaterialCommunityIcons
                    name={PROTOCOL_ICONS[protocol] || 'code'}
                    size={16}
                    color={COLORS.accent}
                  />
                  <Text style={styles.protocolName}>
                    {protocol.replace('_', ' ').toUpperCase()}
                  </Text>
                  <Text style={styles.protocolCount}>{protocolPositions.length}</Text>
                </View>

                {protocolPositions.map((pos, i) => {
                  const globalIndex = positions.indexOf(pos);
                  return (
                    <View key={i} style={styles.positionCard}>
                      <View style={styles.positionHeader}>
                        <Text style={styles.positionType}>{pos.type.replace('_', ' ')}</Text>
                        {isSetupComplete && (
                          <View style={styles.vaultBadge}>
                            <MaterialCommunityIcons name="shield-check" size={10} color={COLORS.accent} />
                            <Text style={styles.vaultBadgeText}>Covered</Text>
                          </View>
                        )}
                      </View>
                      <Text style={styles.positionDesc}>{pos.description}</Text>
                      <View style={styles.positionMeta}>
                        {pos.estimatedValueSol > 0 && (
                          <Text style={styles.positionValue}>~{pos.estimatedValueSol.toFixed(4)} SOL</Text>
                        )}
                        {pos.estimatedValueUsd > 0 && (
                          <Text style={styles.positionUsd}>${pos.estimatedValueUsd.toFixed(2)}</Text>
                        )}
                      </View>

                      {/* Action Row */}
                      <View style={styles.actionRow}>
                        {ACTIONS.map((action) => (
                          <TouchableOpacity
                            key={action}
                            style={[styles.actionButton, pos.action === action && styles.actionButtonActive]}
                            onPress={() => updateAction(globalIndex, action)}
                          >
                            <Text style={[styles.actionText, pos.action === action && styles.actionTextActive]}>
                              {action.charAt(0).toUpperCase() + action.slice(1)}
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </View>
                  );
                })}
              </View>
            ))
          )}
        </View>
      )}

      <View style={{ height: 48 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  center: { flex: 1, backgroundColor: COLORS.bg, justifyContent: 'center', alignItems: 'center', padding: 32 },

  // Header
  header: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 4 },
  headerTitle: { fontSize: 11, fontWeight: '500', color: 'rgba(255,255,255,0.4)', letterSpacing: 1.5, fontFamily: FONTS.primaryMedium },
  headerValue: { fontSize: 32, fontWeight: '700', color: '#FFFFFF', fontFamily: FONTS.primaryBold, letterSpacing: -0.5, marginTop: 4 },

  // Protection badges
  protectionBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: 20, marginTop: 8, marginBottom: 12 },
  protectionText: { fontSize: 12, color: COLORS.accent, fontWeight: '600', fontFamily: FONTS.primarySemiBold },
  unprotectedBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: 20, marginTop: 8, marginBottom: 12 },
  unprotectedText: { fontSize: 12, color: COLORS.warning, fontWeight: '600', fontFamily: FONTS.primarySemiBold },

  // Segment tabs
  segmentContainer: { flexDirection: 'row', marginHorizontal: 16, marginBottom: 12, backgroundColor: COLORS.surface, borderRadius: 12, padding: 3 },
  segmentTab: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 10 },
  segmentTabActive: { backgroundColor: 'rgba(255,255,255,0.08)' },
  segmentText: { fontSize: 13, color: 'rgba(255,255,255,0.4)', fontWeight: '600', fontFamily: FONTS.primarySemiBold },
  segmentTextActive: { color: COLORS.accent },

  // Card
  card: { backgroundColor: COLORS.surface, borderRadius: 16, borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)', marginHorizontal: 16, overflow: 'hidden' },

  // Token rows
  tokenRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  tokenRowBorder: { borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)' },
  tokenIcon: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  tokenIconImage: { width: 28, height: 28, borderRadius: 14 },
  tokenIconText: { fontSize: 10, fontWeight: '700', fontFamily: FONTS.primaryBold },
  tokenInfo: { flex: 1, minWidth: 0 },
  tokenNameRow: { flexDirection: 'row', alignItems: 'center' },
  tokenSymbol: { color: '#FFFFFF', fontSize: 13, fontWeight: '600', fontFamily: FONTS.primarySemiBold },
  tokenAmount: { color: 'rgba(255,255,255,0.35)', fontSize: 11, fontFamily: FONTS.primary, marginTop: 1 },
  tokenRight: { alignItems: 'flex-end' },
  tokenUsd: { color: '#FFFFFF', fontSize: 13, fontWeight: '600', fontFamily: FONTS.primarySemiBold },
  tokenChange: { fontSize: 11, marginTop: 1, fontFamily: FONTS.primary },

  // Loading
  loadingContainer: { padding: 40, alignItems: 'center' },
  loadingText: { color: COLORS.textPrimary, marginTop: SPACING.md, fontSize: 14, fontWeight: '600' },
  loadingSubtext: { color: COLORS.textSecondary, marginTop: SPACING.xs, fontSize: 12 },

  // Empty
  emptyCard: { padding: SPACING.lg, alignItems: 'center', marginHorizontal: 16 },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: COLORS.textPrimary, marginTop: SPACING.md },
  emptyDesc: { fontSize: 13, color: COLORS.textSecondary, textAlign: 'center', marginTop: SPACING.sm, lineHeight: 18 },

  // DeFi positions
  protocolGroup: { marginHorizontal: 16, marginBottom: SPACING.md },
  protocolHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: SPACING.sm, gap: SPACING.sm },
  protocolName: { fontSize: 12, fontWeight: '700', color: COLORS.textPrimary, letterSpacing: 0.5, flex: 1, fontFamily: FONTS.primaryBold },
  protocolCount: { fontSize: 11, color: COLORS.textMuted, fontFamily: FONTS.mono },
  positionCard: { backgroundColor: COLORS.surface, borderRadius: 12, padding: SPACING.md, marginBottom: SPACING.sm, borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)' },
  positionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: SPACING.xs },
  positionType: { fontSize: 14, fontWeight: '600', color: COLORS.textPrimary, textTransform: 'capitalize', fontFamily: FONTS.primarySemiBold },
  positionDesc: { fontSize: 12, color: COLORS.textSecondary, lineHeight: 18 },
  positionMeta: { flexDirection: 'row', gap: SPACING.md, marginTop: SPACING.sm },
  positionValue: { fontSize: 13, color: COLORS.textPrimary, fontWeight: '600', fontFamily: FONTS.mono },
  positionUsd: { fontSize: 13, color: COLORS.textSecondary, fontFamily: FONTS.mono },

  // Vault coverage badge
  vaultBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(0,212,180,0.1)', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6 },
  vaultBadgeText: { fontSize: 10, color: COLORS.accent, fontWeight: '600', fontFamily: FONTS.primarySemiBold },

  // Action buttons
  actionRow: { flexDirection: 'row', gap: SPACING.sm, marginTop: SPACING.md },
  actionButton: { flex: 1, paddingVertical: SPACING.sm, borderRadius: 8, borderWidth: 1, borderColor: COLORS.border, alignItems: 'center' },
  actionButtonActive: { borderColor: COLORS.accent, backgroundColor: COLORS.accent + '20' },
  actionText: { fontSize: 12, color: COLORS.textMuted },
  actionTextActive: { color: COLORS.accent, fontWeight: '600' },
});
