import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  RefreshControl,
  TouchableOpacity,
  Animated,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { useWallet } from '../hooks/useWallet';
import { usePortfolio } from '../hooks/usePortfolio';
import { useVaultProgram } from '../hooks/useVaultProgram';
import { useHeartbeat } from '../hooks/useHeartbeat';
import { useDemoStore } from '../store/useDemoStore';
import { useVaultStore } from '../store/useVaultStore';
import { useEscalationStore } from '../store/useEscalationStore';
import { DeFiPosition } from '../types/defi';
import { StatusIndicator } from '../components/StatusIndicator';
import { HeartbeatButton } from '../components/HeartbeatButton';
import { EscalationBanner } from '../components/EscalationBanner';
import { COLORS, SPACING, FONTS, STAGE_CONFIG, TOKEN_COLORS } from '../utils/constants';
import { formatUsd, formatTokenAmount, truncateAddress, timeAgo } from '../utils/formatting';
import { EscalationStage } from '../types';

// --- Helpers ---

function TokenIcon({ symbol }: { symbol: string }) {
  const color = TOKEN_COLORS[symbol] || COLORS.accent;
  return (
    <View style={[styles.tokenIcon, { backgroundColor: color + '22', borderColor: color + '44' }]}>
      <Text style={[styles.tokenIconText, { color }]}>{symbol.slice(0, 3)}</Text>
    </View>
  );
}

function DemoControls({ stage }: { stage: EscalationStage }) {
  const setEscalationStage = useEscalationStore((s) => s.setStage);
  const stages: EscalationStage[] = [0, 1, 2, 3, 4];

  return (
    <View style={styles.demoControlsContainer}>
      <Text style={styles.demoControlsLabel}>DEMO — ESCALATION STAGES</Text>
      <View style={styles.demoControlsRow}>
        {stages.map((s) => {
          const c = STAGE_CONFIG[s];
          const active = s === stage;
          return (
            <TouchableOpacity
              key={s}
              style={[
                styles.demoControlsButton,
                {
                  backgroundColor: active ? c.dimColor : 'rgba(255,255,255,0.04)',
                  borderColor: active ? c.borderColor : 'rgba(255,255,255,0.06)',
                },
              ]}
              onPress={() => setEscalationStage(s)}
            >
              <Text
                style={[
                  styles.demoControlsButtonText,
                  { color: active ? c.color : 'rgba(255,255,255,0.3)' },
                ]}
              >
                S{s}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

function SkeletonBar({ width, height, style }: { width: number | string; height: number; style?: any }) {
  const opacity = useRef(new Animated.Value(0.3)).current;
  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.7, duration: 800, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.3, duration: 800, useNativeDriver: true }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, []);
  return (
    <Animated.View style={[{ width: width as any, height, backgroundColor: COLORS.surfaceHover, borderRadius: 4, opacity }, style]} />
  );
}

function SkeletonTokenRow() {
  return (
    <View style={[styles.tokenRow, { borderTopWidth: 0 }]}>
      <View style={styles.tokenLeft}>
        <SkeletonBar width={36} height={36} style={{ borderRadius: 18 }} />
        <View>
          <SkeletonBar width={50} height={14} />
          <SkeletonBar width={80} height={12} style={{ marginTop: 4 }} />
        </View>
      </View>
      <View style={styles.tokenRight}>
        <SkeletonBar width={60} height={14} />
      </View>
    </View>
  );
}

// --- Main Component ---

export function DashboardScreen() {
  const navigation = useNavigation<any>();
  const { publicKey, connected, connect } = useWallet();
  const { balances, totalUsdValue, solBalance, isLoading, error, refresh } = usePortfolio();
  const { fetchVaultConfig, fetchHeartbeatRecord, getVaultPDA } = useVaultProgram();
  const isDemoMode = useDemoStore((s) => s.isDemoMode);
  const [vaultData, setVaultData] = useState<any>(null);
  const [heartbeatData, setHeartbeatData] = useState<any>(null);
  const [isLoadingVault, setIsLoadingVault] = useState(false);
  const defiPositions = useVaultStore((s) => s.defiPositions);

  // Wallet-switch detection
  const prevPublicKey = useRef(publicKey?.toBase58() ?? '');

  const isVaultSetup = vaultData !== null;

  const {
    confirmHeartbeat,
    status: heartbeatStatus,
    escalationStage,
    secondsRemaining,
    isConfirming,
  } = useHeartbeat(isVaultSetup && (vaultData?.active ?? false));

  const cfg = STAGE_CONFIG[escalationStage] || STAGE_CONFIG[0];

  const loadVaultState = useCallback(async () => {
    if (!publicKey) return;
    setIsLoadingVault(true);
    try {
      let vault: any = await fetchVaultConfig(publicKey);
      if (!vault) {
        const { VaultTransactionService } = require('../services/VaultTransactionService');
        const txService = new VaultTransactionService();
        const [vaultPda] = txService.getVaultPDA(publicKey);
        const rawAccount = await txService.getConnection().getAccountInfo(vaultPda);
        if (rawAccount && rawAccount.data.length > 0) {
          vault = await txService.fetchVaultConfig(publicKey);
          if (!vault) {
            const store = useVaultStore.getState();
            vault = {
              active: true,
              executed: false,
              beneficiaries: store.beneficiaries.map((b: any) => ({
                wallet: b.wallet,
                shareBps: b.shareBps,
                hasSpecificAssets: b.hasSpecificAssets ?? false,
              })),
            };
          }
        }
      }
      setVaultData(vault);
      if (vault) {
        useVaultStore.getState().setSetupComplete(true);
        const [vaultPda] = getVaultPDA(publicKey);
        const hb = await fetchHeartbeatRecord(vaultPda);
        setHeartbeatData(hb);
      }
    } catch {
      // Non-fatal
    } finally {
      setIsLoadingVault(false);
    }
  }, [publicKey, fetchVaultConfig, fetchHeartbeatRecord, getVaultPDA]);

  // Detect wallet switch — reset vault state when wallet changes
  useEffect(() => {
    const currentKey = publicKey?.toBase58() ?? '';
    if (prevPublicKey.current && currentKey && prevPublicKey.current !== currentKey) {
      setVaultData(null);
      setHeartbeatData(null);
      useVaultStore.getState().reset?.();
    }
    prevPublicKey.current = currentKey;
  }, [publicKey]);

  useEffect(() => {
    if (connected && publicKey) {
      refresh();
      loadVaultState();
    }
  }, [connected, publicKey]);

  useFocusEffect(
    useCallback(() => {
      if (connected && publicKey) {
        loadVaultState();
      }
    }, [connected, publicKey, loadVaultState]),
  );

  const onRefresh = useCallback(async () => {
    await Promise.all([refresh(), loadVaultState()]);
  }, [refresh, loadVaultState]);

  const handleHeartbeat = useCallback(async () => {
    try {
      await confirmHeartbeat('active_tap');
      await loadVaultState();
    } catch {
      // Error handling
    }
  }, [confirmHeartbeat, loadVaultState]);

  // Heartbeat stats
  const lastBeatLabel = heartbeatData
    ? timeAgo(heartbeatData.lastHeartbeat.toNumber())
    : heartbeatStatus?.lastHeartbeat
      ? timeAgo(heartbeatStatus.lastHeartbeat)
      : 'N/A';

  const nextDueLabel = escalationStage === 0
    ? (heartbeatStatus?.nextDue ? timeAgo(heartbeatStatus.nextDue).replace(' ago', '') : 'N/A')
    : 'Overdue';

  const beneficiaryCount = vaultData?.beneficiaries?.length ?? useVaultStore.getState().beneficiaries.length;

  // Not connected state
  if (!connected) {
    return (
      <View style={styles.centerContainer}>
        <View style={styles.connectLogoContainer}>
          <MaterialCommunityIcons name="shield-lock" size={40} color={COLORS.accent} />
        </View>
        <Text style={styles.heroTitle}>Dead Man's Vault</Text>
        <Text style={styles.heroSubtitle}>Connect your wallet to get started</Text>
        <TouchableOpacity style={styles.connectButton} onPress={connect}>
          <Text style={styles.connectButtonText}>Connect Wallet</Text>
          <MaterialCommunityIcons name="arrow-right" size={18} color={COLORS.bg} style={{ marginLeft: 8 }} />
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl refreshing={isLoading} onRefresh={onRefresh} tintColor={COLORS.accent} />
      }
    >
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View style={styles.headerLogo}>
            <MaterialCommunityIcons name="shield" size={16} color={COLORS.solanaPurple} />
          </View>
          <View>
            <Text style={styles.headerTitle}>Dead Man's Vault</Text>
            <Text style={styles.headerSubtitle}>Solana Seeker</Text>
          </View>
        </View>
        <TouchableOpacity style={styles.headerSettingsBtn} onPress={() => navigation.getParent()?.navigate('Settings')}>
          <MaterialCommunityIcons name="cog" size={16} color="rgba(255,255,255,0.5)" />
        </TouchableOpacity>
      </View>

      {/* Demo badge */}
      {isDemoMode && (
        <View style={styles.demoBadge}>
          <Text style={styles.demoBadgeText}>DEMO MODE</Text>
        </View>
      )}

      {/* === VAULT STATUS CARD (MOVED TO TOP) === */}
      {isVaultSetup && !vaultData?.executed && (
        <View style={[styles.vaultCard, { borderColor: cfg.borderColor }]}>
          {/* Status Header */}
          <StatusIndicator stage={escalationStage} isActive={vaultData?.active ?? false} />

          {/* Heartbeat Button */}
          <View style={styles.heartbeatContainer}>
            <HeartbeatButton
              onPress={handleHeartbeat}
              disabled={!isVaultSetup}
              loading={isConfirming}
              stage={escalationStage}
              secondsRemaining={secondsRemaining}
            />
          </View>

          {/* Stats Row */}
          <View style={styles.statsRow}>
            <View style={styles.statCell}>
              <MaterialCommunityIcons name="clock-outline" size={11} color={escalationStage > 0 ? cfg.color : 'rgba(255,255,255,0.3)'} />
              <Text style={[styles.statValue, escalationStage > 0 && { color: cfg.color }]}>{lastBeatLabel}</Text>
              <Text style={styles.statLabel}>Last Beat</Text>
            </View>
            <View style={[styles.statCell, styles.statCellBorder]}>
              <MaterialCommunityIcons name="clock-outline" size={11} color={escalationStage > 0 ? cfg.color : 'rgba(255,255,255,0.3)'} />
              <Text style={[styles.statValue, escalationStage > 0 && { color: cfg.color }]}>{nextDueLabel}</Text>
              <Text style={styles.statLabel}>Next Due</Text>
            </View>
            <View style={styles.statCell}>
              <MaterialCommunityIcons name="account-group" size={11} color="rgba(255,255,255,0.3)" />
              <Text style={styles.statValue}>{String(beneficiaryCount)}</Text>
              <Text style={styles.statLabel}>Beneficiaries</Text>
            </View>
          </View>
        </View>
      )}

      {/* Escalation Banner */}
      {escalationStage > 0 && escalationStage < 4 && (
        <View style={{ marginHorizontal: 16, marginBottom: 12 }}>
          <EscalationBanner stage={escalationStage} secondsRemaining={secondsRemaining} />
        </View>
      )}

      {/* Execution In Progress */}
      {escalationStage === 4 && (
        <TouchableOpacity style={styles.executionCard} onPress={() => navigation.navigate('ExecutionLog')}>
          <MaterialCommunityIcons name="alert-octagon" size={20} color={COLORS.critical} />
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={styles.executionTitle}>Distribution In Progress</Text>
            <Text style={styles.executionSubtitle}>Assets are being distributed to beneficiaries.</Text>
          </View>
          <MaterialCommunityIcons name="chevron-right" size={18} color="rgba(255,255,255,0.3)" />
        </TouchableOpacity>
      )}

      {/* Vault Executed */}
      {vaultData?.executed && (
        <View style={styles.executedCard}>
          <MaterialCommunityIcons name="check-circle" size={20} color={COLORS.accent} />
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={styles.executedTitle}>Vault Executed</Text>
            <Text style={styles.executedSubtitle}>Estate plan executed. Assets distributed.</Text>
          </View>
        </View>
      )}

      {/* === PORTFOLIO + TOKENS MERGED === */}
      <View style={styles.portfolioCard}>
        <View style={styles.portfolioHeader}>
          <Text style={styles.portfolioLabel}>YOUR PORTFOLIO</Text>
          <Text style={styles.tokenListCount}>{balances.length} assets</Text>
        </View>
        {isLoading && balances.length === 0 ? (
          <View style={styles.portfolioSummary}>
            <SkeletonBar width={180} height={36} />
            <SkeletonBar width={100} height={14} style={{ marginTop: 8 }} />
          </View>
        ) : (
          <View style={styles.portfolioSummary}>
            <Text style={styles.portfolioValue}>{formatUsd(totalUsdValue)}</Text>
            <Text style={styles.portfolioSubtext}>
              {formatTokenAmount(solBalance, 4)} SOL
            </Text>
          </View>
        )}

        {/* Divider */}
        <View style={styles.portfolioDivider} />

        {/* Token List */}
        {error && <Text style={styles.errorText}>{error}</Text>}
        {isLoading && balances.length === 0 ? (
          <>
            <SkeletonTokenRow />
            <SkeletonTokenRow />
            <SkeletonTokenRow />
          </>
        ) : balances.length === 0 ? (
          <Text style={styles.emptyText}>No tokens found</Text>
        ) : (
          balances.map((token, i) => (
            <View
              key={i}
              style={[styles.tokenRow, i < balances.length - 1 && styles.tokenRowBorder]}
            >
              <TokenIcon symbol={token.symbol} />
              <View style={styles.tokenLeft}>
                <Text style={styles.tokenSymbol}>{token.symbol}</Text>
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

      {/* DeFi Positions Summary — NOW TAPPABLE */}
      {defiPositions.length > 0 && (
        <TouchableOpacity
          style={styles.card}
          activeOpacity={0.7}
          onPress={() => navigation.navigate('DeFiPositions')}
        >
          <View style={styles.defiHeader}>
            <Text style={styles.sectionLabel}>DEFI POSITIONS ({defiPositions.length})</Text>
            <View style={styles.defiViewAll}>
              <Text style={styles.defiViewAllText}>View All</Text>
              <MaterialCommunityIcons name="chevron-right" size={14} color={COLORS.accent} />
            </View>
          </View>
          {defiPositions.slice(0, 3).map((pos: DeFiPosition, i: number) => (
            <View key={i} style={styles.defiRow}>
              <Text style={styles.defiLabel}>{pos.protocol.replace('_', ' ')}</Text>
              <Text style={styles.defiValue}>
                {pos.estimatedValueSol > 0 ? `~${pos.estimatedValueSol.toFixed(4)} SOL` : pos.type}
              </Text>
            </View>
          ))}
          {defiPositions.length > 3 && (
            <Text style={styles.defiMore}>+{defiPositions.length - 3} more positions</Text>
          )}
        </TouchableOpacity>
      )}

      {/* Setup CTA if no vault */}
      {!isVaultSetup && (
        <TouchableOpacity
          style={styles.setupCta}
          onPress={() => navigation.getParent()?.navigate('Setup')}
        >
          <View style={styles.setupCtaIcon}>
            <MaterialCommunityIcons name="account-group" size={16} color={COLORS.solanaPurple} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.setupCtaTitle}>No beneficiaries set</Text>
            <Text style={styles.setupCtaSubtitle}>Complete vault setup to protect your crypto</Text>
          </View>
          <MaterialCommunityIcons name="chevron-right" size={16} color="rgba(153,69,255,0.6)" />
        </TouchableOpacity>
      )}

      {/* Demo Controls */}
      {isDemoMode && <DemoControls stage={escalationStage} />}

      <View style={{ height: 48 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  centerContainer: {
    flex: 1,
    backgroundColor: COLORS.bg,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  connectLogoContainer: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(0,255,163,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(0,255,163,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
  },
  heroTitle: {
    fontSize: 26,
    fontWeight: '700',
    color: COLORS.textPrimary,
    fontFamily: FONTS.primaryBold,
    marginBottom: 8,
  },
  heroSubtitle: {
    fontSize: 14,
    color: COLORS.textSecondary,
    fontFamily: FONTS.primary,
    marginBottom: 32,
    textAlign: 'center',
  },
  connectButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.accent,
    paddingVertical: 16,
    paddingHorizontal: 32,
    borderRadius: 16,
  },
  connectButtonText: {
    color: COLORS.bg,
    fontSize: 15,
    fontWeight: '700',
    fontFamily: FONTS.primaryBold,
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerLogo: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: 'rgba(153,69,255,0.2)',
    borderWidth: 1,
    borderColor: 'rgba(153,69,255,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 14,
    fontFamily: FONTS.primaryBold,
  },
  headerSubtitle: {
    color: 'rgba(255,255,255,0.35)',
    fontSize: 10,
    fontFamily: FONTS.primary,
  },
  headerSettingsBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Demo badge
  demoBadge: {
    backgroundColor: 'rgba(0,255,163,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(0,255,163,0.2)',
    borderRadius: 20,
    paddingVertical: 4,
    paddingHorizontal: 12,
    alignSelf: 'center',
    marginTop: 4,
    marginBottom: 8,
  },
  demoBadgeText: {
    color: COLORS.accent,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.5,
    fontFamily: FONTS.primaryBold,
  },

  // Vault Status Card
  vaultCard: {
    backgroundColor: COLORS.surface,
    borderRadius: 16,
    borderWidth: 1,
    marginHorizontal: 16,
    marginBottom: 12,
    overflow: 'hidden',
  },
  heartbeatContainer: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  statsRow: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginBottom: 16,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 10,
    overflow: 'hidden',
  },
  statCell: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    backgroundColor: COLORS.surface,
  },
  statCellBorder: {
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  statValue: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
    marginTop: 2,
    fontFamily: FONTS.primaryBold,
  },
  statLabel: {
    color: 'rgba(255,255,255,0.3)',
    fontSize: 9,
    marginTop: 1,
    fontFamily: FONTS.primary,
  },

  // Execution card
  executionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(220,38,38,0.1)',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(220,38,38,0.3)',
    padding: 16,
    marginHorizontal: 16,
    marginBottom: 12,
  },
  executionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.critical,
    fontFamily: FONTS.primaryBold,
  },
  executionSubtitle: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginTop: 2,
    fontFamily: FONTS.primary,
  },

  // Executed card
  executedCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,255,163,0.06)',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(0,255,163,0.2)',
    padding: 16,
    marginHorizontal: 16,
    marginBottom: 12,
  },
  executedTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.accent,
    fontFamily: FONTS.primaryBold,
  },
  executedSubtitle: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginTop: 2,
    fontFamily: FONTS.primary,
  },

  // Portfolio Card (merged with tokens)
  portfolioCard: {
    backgroundColor: COLORS.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    marginHorizontal: 16,
    marginBottom: 12,
    overflow: 'hidden',
  },
  portfolioHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 4,
  },
  portfolioLabel: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 11,
    fontWeight: '500',
    letterSpacing: 1.5,
    fontFamily: FONTS.primaryMedium,
  },
  portfolioSummary: {
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  portfolioValue: {
    fontSize: 36,
    fontWeight: '700',
    color: '#FFFFFF',
    letterSpacing: -0.5,
    fontFamily: FONTS.primaryBold,
    lineHeight: 40,
  },
  portfolioSubtext: {
    color: 'rgba(255,255,255,0.25)',
    fontSize: 11,
    marginTop: 4,
    fontFamily: FONTS.primary,
  },
  portfolioDivider: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.06)',
    marginHorizontal: 16,
  },
  tokenListCount: {
    color: 'rgba(255,255,255,0.2)',
    fontSize: 10,
    fontFamily: FONTS.primary,
  },
  tokenRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  tokenRowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.05)',
  },
  tokenIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tokenIconText: {
    fontSize: 10,
    fontWeight: '700',
    fontFamily: FONTS.primaryBold,
  },
  tokenLeft: {
    flex: 1,
    minWidth: 0,
  },
  tokenSymbol: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
    fontFamily: FONTS.primarySemiBold,
  },
  tokenAmount: {
    color: 'rgba(255,255,255,0.35)',
    fontSize: 11,
    fontFamily: FONTS.primary,
    marginTop: 1,
  },
  tokenRight: {
    alignItems: 'flex-end',
  },
  tokenUsd: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
    fontFamily: FONTS.primarySemiBold,
  },
  tokenChange: {
    fontSize: 11,
    marginTop: 1,
    fontFamily: FONTS.primary,
  },

  // Setup CTA
  setupCta: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(153,69,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(153,69,255,0.2)',
    borderRadius: 16,
    padding: 16,
    marginHorizontal: 16,
    marginBottom: 12,
    gap: 12,
  },
  setupCtaIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: 'rgba(153,69,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  setupCtaTitle: {
    color: COLORS.solanaPurple,
    fontSize: 12,
    fontWeight: '600',
    fontFamily: FONTS.primarySemiBold,
  },
  setupCtaSubtitle: {
    color: 'rgba(255,255,255,0.35)',
    fontSize: 11,
    fontFamily: FONTS.primary,
  },

  // Card
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    padding: 16,
    marginHorizontal: 16,
    marginBottom: 12,
  },
  sectionLabel: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1,
    fontFamily: FONTS.primarySemiBold,
  },
  defiHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  defiViewAll: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  defiViewAllText: {
    color: COLORS.accent,
    fontSize: 11,
    fontWeight: '600',
    fontFamily: FONTS.primarySemiBold,
  },
  defiRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  defiLabel: {
    color: COLORS.textSecondary,
    fontSize: 12,
    fontFamily: FONTS.primary,
  },
  defiValue: {
    color: COLORS.textPrimary,
    fontSize: 12,
    fontWeight: '500',
    fontFamily: FONTS.primaryMedium,
  },
  defiMore: {
    color: COLORS.textMuted,
    fontSize: 11,
    marginTop: 4,
    fontFamily: FONTS.primary,
  },

  // Error/empty
  errorText: {
    fontSize: 12,
    color: COLORS.critical,
    padding: 16,
    fontFamily: FONTS.primary,
  },
  emptyText: {
    fontSize: 13,
    color: COLORS.textMuted,
    textAlign: 'center',
    padding: 24,
    fontFamily: FONTS.primary,
  },

  // Demo controls
  demoControlsContainer: {
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  demoControlsLabel: {
    color: 'rgba(255,255,255,0.25)',
    fontSize: 9,
    fontWeight: '600',
    letterSpacing: 1,
    marginBottom: 6,
    fontFamily: FONTS.primarySemiBold,
  },
  demoControlsRow: {
    flexDirection: 'row',
    gap: 6,
  },
  demoControlsButton: {
    flex: 1,
    borderRadius: 8,
    paddingVertical: 4,
    borderWidth: 1,
    alignItems: 'center',
  },
  demoControlsButtonText: {
    fontSize: 10,
    fontWeight: '600',
    fontFamily: FONTS.primarySemiBold,
  },
});
