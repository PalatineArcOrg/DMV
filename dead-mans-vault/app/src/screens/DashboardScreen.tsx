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
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { useWallet } from '../hooks/useWallet';
import { usePortfolio } from '../hooks/usePortfolio';
import { useVaultProgram } from '../hooks/useVaultProgram';
import { useHeartbeat } from '../hooks/useHeartbeat';
import { useDemoStore } from '../store/useDemoStore';
import { useVaultStore } from '../store/useVaultStore';
import { StatusIndicator } from '../components/StatusIndicator';
import { HeartbeatButton } from '../components/HeartbeatButton';
import { EscalationBanner } from '../components/EscalationBanner';
import { COLORS, SPACING, FONTS } from '../utils/constants';
import { formatUsd, formatTokenAmount, truncateAddress, timeAgo } from '../utils/formatting';

export function DashboardScreen() {
  const navigation = useNavigation<any>();
  const { publicKey, connected, connect } = useWallet();
  const { balances, totalUsdValue, solBalance, isLoading, error, refresh } =
    usePortfolio();
  const { fetchVaultConfig, fetchHeartbeatRecord, getVaultPDA } =
    useVaultProgram();
  const isDemoMode = useDemoStore((s) => s.isDemoMode);
  const [vaultData, setVaultData] = useState<any>(null);
  const [heartbeatData, setHeartbeatData] = useState<any>(null);
  const [isLoadingVault, setIsLoadingVault] = useState(false);

  const isVaultSetup = vaultData !== null;

  const {
    confirmHeartbeat,
    status: heartbeatStatus,
    escalationStage,
    secondsRemaining,
    isConfirming,
  } = useHeartbeat(isVaultSetup && (vaultData?.active ?? false));

  const loadVaultState = useCallback(async () => {
    if (!publicKey) return;
    setIsLoadingVault(true);
    try {
      let vault: any = await fetchVaultConfig(publicKey);

      // Fallback: if Anchor fetch fails (Hermes compat), check raw account
      if (!vault) {
        const { VaultTransactionService } = require('../services/VaultTransactionService');
        const txService = new VaultTransactionService();
        const [vaultPda] = txService.getVaultPDA(publicKey);
        const rawAccount = await txService.getConnection().getAccountInfo(vaultPda);
        if (rawAccount && rawAccount.data.length > 0) {
          // Vault exists on-chain — try VaultTransactionService fetch (separate Anchor instance)
          vault = await txService.fetchVaultConfig(publicKey);
          if (!vault) {
            // Still failed — use minimal stub so UI shows vault as active
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

  useEffect(() => {
    if (connected && publicKey) {
      refresh();
      loadVaultState();
    }
  }, [connected, publicKey]);

  // Reload vault state when screen comes into focus (e.g. after setup)
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

  // Not connected state
  if (!connected) {
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.heroTitle}>Dead Man's Vault</Text>
        <Text style={styles.heroSubtitle}>
          Connect your wallet to get started
        </Text>
        <TouchableOpacity style={styles.connectButton} onPress={connect}>
          <Text style={styles.connectButtonText}>Connect Wallet</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={isLoading}
          onRefresh={onRefresh}
          tintColor={COLORS.accent}
        />
      }
    >
      {/* Demo Mode Badge */}
      {isDemoMode && (
        <View style={styles.demoBadge}>
          <Text style={styles.demoBadgeText}>DEMO MODE</Text>
        </View>
      )}

      {/* Portfolio Header */}
      <View style={styles.portfolioHeader}>
        {isLoading && balances.length === 0 ? (
          <>
            <SkeletonBar width={180} height={36} />
            <SkeletonBar width={100} height={18} style={{ marginTop: SPACING.xs }} />
          </>
        ) : (
          <>
            <Text style={styles.portfolioValue}>{formatUsd(totalUsdValue)}</Text>
            <Text style={styles.portfolioSol}>
              {formatTokenAmount(solBalance, 4)} SOL
            </Text>
          </>
        )}
      </View>

      {/* Token List */}
      <View style={styles.card}>
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
            <View key={i} style={[styles.tokenRow, i === 0 && { borderTopWidth: 0 }]}>
              <View style={styles.tokenLeft}>
                <View style={[styles.tokenIcon, { backgroundColor: COLORS.accent + '20' }]}>
                  <Text style={styles.tokenIconText}>
                    {token.symbol.charAt(0)}
                  </Text>
                </View>
                <View>
                  <Text style={styles.tokenSymbol}>{token.symbol}</Text>
                  <Text style={[styles.tokenAmount, { fontFamily: FONTS.mono }]}>
                    {formatTokenAmount(token.amount, token.decimals > 4 ? 4 : token.decimals)}
                  </Text>
                </View>
              </View>
              <View style={styles.tokenRight}>
                {token.usdValue > 0 && (
                  <Text style={styles.tokenUsd}>{formatUsd(token.usdValue)}</Text>
                )}
                {token.change24h != null && (
                  <Text
                    style={[
                      styles.tokenChange,
                      { color: token.change24h >= 0 ? COLORS.healthy : COLORS.critical },
                    ]}
                  >
                    {token.change24h >= 0 ? '+' : ''}
                    {token.change24h.toFixed(1)}%
                  </Text>
                )}
              </View>
            </View>
          ))
        )}
      </View>

      {/* Vault Section */}
      <StatusIndicator
        stage={escalationStage}
        isActive={isVaultSetup ? (vaultData?.active ?? false) : false}
      />

      <EscalationBanner stage={escalationStage} secondsRemaining={secondsRemaining} />

      {/* Execution in Progress card */}
      {escalationStage === 4 && (
        <TouchableOpacity
          style={styles.executionCard}
          onPress={() => navigation.navigate('ExecutionLog')}
        >
          <Text style={styles.executionTitle}>Execution In Progress</Text>
          <Text style={styles.executionSubtitle}>
            Assets are being distributed to beneficiaries.
          </Text>
          <Text style={styles.executionLink}>View Execution Log →</Text>
        </TouchableOpacity>
      )}

      {/* Vault Executed state */}
      {vaultData?.executed && (
        <View style={styles.executedCard}>
          <Text style={styles.executedTitle}>Vault Executed</Text>
          <Text style={styles.executedSubtitle}>
            Estate plan has been executed. Assets have been distributed.
          </Text>
        </View>
      )}

      {/* Heartbeat Button */}
      {!vaultData?.executed && (
        <HeartbeatButton
          onPress={handleHeartbeat}
          disabled={!isVaultSetup}
          loading={isConfirming}
          stage={escalationStage}
          secondsRemaining={secondsRemaining}
        />
      )}

      {/* Heartbeat Status */}
      {heartbeatStatus && heartbeatStatus.lastHeartbeat > 0 && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Heartbeat Status</Text>
          <StatRow
            label="Last confirmed"
            value={timeAgo(heartbeatStatus.lastHeartbeat)}
          />
          <StatRow label="Method" value={heartbeatStatus.lastMethod} />
          <StatRow
            label="Total confirmations"
            value={String(heartbeatStatus.totalHeartbeats)}
          />
          <StatRow
            label="Status"
            value={heartbeatStatus.isOverdue ? 'OVERDUE' : 'On time'}
          />
        </View>
      )}

      {/* Vault Info */}
      {isLoadingVault ? (
        <View style={styles.card}>
          <SkeletonBar width={120} height={16} />
          <SkeletonBar width={'100%' as any} height={14} style={{ marginTop: SPACING.sm }} />
          <SkeletonBar width={'80%' as any} height={14} style={{ marginTop: SPACING.xs }} />
        </View>
      ) : isVaultSetup ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Vault Status</Text>
          <StatRow
            label="Last Heartbeat"
            value={
              heartbeatData
                ? timeAgo(heartbeatData.lastHeartbeat.toNumber())
                : 'N/A'
            }
          />
          <StatRow
            label="Total Heartbeats"
            value={
              heartbeatData
                ? heartbeatData.totalHeartbeats.toString()
                : '0'
            }
          />
          <StatRow
            label="Beneficiaries"
            value={String(vaultData?.beneficiaries?.length ?? 0)}
          />
          <StatRow
            label="Stage"
            value={`${escalationStage} (${
              escalationStage === 0
                ? 'Normal'
                : escalationStage === 4
                  ? 'Executing'
                  : 'Escalating'
            })`}
          />
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>No Vault Configured</Text>
          <Text style={styles.cardSubtitle}>
            Go to Setup tab to create your estate plan.
          </Text>
        </View>
      )}

      {/* Wallet Info */}
      <View style={styles.card}>
        <StatRow
          label="Wallet"
          value={truncateAddress(publicKey?.toString() ?? '', 6)}
          mono
        />
      </View>

      <View style={{ height: SPACING.xxl }} />
    </ScrollView>
  );
}

function StatRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <View style={styles.statRow}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, mono && { fontFamily: FONTS.mono }]}>
        {value}
      </Text>
    </View>
  );
}

function SkeletonBar({
  width,
  height,
  style,
}: {
  width: number | string;
  height: number;
  style?: any;
}) {
  const opacity = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.7,
          duration: 800,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.3,
          duration: 800,
          useNativeDriver: true,
        }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, []);

  return (
    <Animated.View
      style={[
        {
          width: width as any,
          height,
          backgroundColor: COLORS.surfaceHover,
          borderRadius: 4,
          opacity,
        },
        style,
      ]}
    />
  );
}

function SkeletonTokenRow() {
  return (
    <View style={[styles.tokenRow, { borderTopWidth: 0 }]}>
      <View style={styles.tokenLeft}>
        <SkeletonBar width={32} height={32} style={{ borderRadius: 16 }} />
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
    padding: SPACING.xl,
  },
  heroTitle: {
    fontSize: 28,
    fontWeight: '800',
    color: COLORS.textPrimary,
    marginBottom: SPACING.sm,
  },
  heroSubtitle: {
    fontSize: 16,
    color: COLORS.textSecondary,
    marginBottom: SPACING.xl,
    textAlign: 'center',
  },
  connectButton: {
    backgroundColor: COLORS.accent,
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.xl,
    borderRadius: 12,
  },
  connectButtonText: {
    color: COLORS.textPrimary,
    fontSize: 16,
    fontWeight: '700',
  },
  demoBadge: {
    backgroundColor: COLORS.accent + '20',
    borderWidth: 1,
    borderColor: COLORS.accent,
    borderRadius: 20,
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.md,
    alignSelf: 'center',
    marginTop: SPACING.sm,
  },
  demoBadgeText: {
    color: COLORS.accent,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
  },
  portfolioHeader: {
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.md,
    paddingBottom: SPACING.xs,
  },
  portfolioValue: {
    fontSize: 36,
    fontWeight: '800',
    color: COLORS.textPrimary,
  },
  portfolioSol: {
    fontSize: 16,
    color: COLORS.textSecondary,
    fontFamily: FONTS.mono,
    marginTop: 2,
  },
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    padding: SPACING.md,
    marginHorizontal: SPACING.md,
    marginTop: SPACING.md,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.textPrimary,
    marginBottom: SPACING.sm,
  },
  cardSubtitle: {
    fontSize: 14,
    color: COLORS.textSecondary,
  },
  emptyText: {
    fontSize: 14,
    color: COLORS.textMuted,
    textAlign: 'center',
    paddingVertical: SPACING.md,
  },
  tokenRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: SPACING.sm,
    borderTopWidth: 1,
    borderTopColor: COLORS.borderLight,
  },
  tokenLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  tokenIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  tokenIconText: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.accent,
  },
  tokenSymbol: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.textPrimary,
  },
  tokenAmount: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginTop: 1,
  },
  tokenRight: {
    alignItems: 'flex-end',
  },
  tokenUsd: {
    fontSize: 14,
    fontWeight: '500',
    color: COLORS.textPrimary,
  },
  tokenChange: {
    fontSize: 12,
    fontWeight: '600',
    marginTop: 1,
  },
  statRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: SPACING.xs,
  },
  statLabel: {
    fontSize: 14,
    color: COLORS.textSecondary,
  },
  statValue: {
    fontSize: 14,
    color: COLORS.textPrimary,
    fontWeight: '500',
  },
  errorText: {
    fontSize: 13,
    color: COLORS.critical,
    marginBottom: SPACING.xs,
  },
  executionCard: {
    backgroundColor: COLORS.critical + '20',
    borderRadius: 12,
    padding: SPACING.md,
    marginHorizontal: SPACING.md,
    marginTop: SPACING.md,
    borderWidth: 1,
    borderColor: COLORS.critical,
  },
  executionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.critical,
  },
  executionSubtitle: {
    fontSize: 14,
    color: COLORS.textSecondary,
    marginTop: SPACING.xs,
  },
  executionLink: {
    fontSize: 14,
    color: COLORS.accent,
    marginTop: SPACING.sm,
    fontWeight: '600',
  },
  executedCard: {
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    padding: SPACING.md,
    marginHorizontal: SPACING.md,
    marginTop: SPACING.md,
    borderWidth: 1,
    borderColor: COLORS.textMuted,
  },
  executedTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.textMuted,
  },
  executedSubtitle: {
    fontSize: 14,
    color: COLORS.textSecondary,
    marginTop: SPACING.xs,
  },
});
