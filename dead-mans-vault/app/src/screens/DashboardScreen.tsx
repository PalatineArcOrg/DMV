import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  RefreshControl,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { useWallet } from '../hooks/useWallet';
import { usePortfolio } from '../hooks/usePortfolio';
import { useVaultProgram } from '../hooks/useVaultProgram';
import { useHeartbeat } from '../hooks/useHeartbeat';
import { StatusIndicator } from '../components/StatusIndicator';
import { HeartbeatButton } from '../components/HeartbeatButton';
import { EscalationBanner } from '../components/EscalationBanner';
import { COLORS, SPACING } from '../utils/constants';
import { formatUsd, formatTokenAmount, truncateAddress, timeAgo } from '../utils/formatting';

export function DashboardScreen() {
  const { publicKey, connected, connect } = useWallet();
  const { balances, totalUsdValue, solBalance, isLoading, error, refresh } =
    usePortfolio();
  const { fetchVaultConfig, fetchHeartbeatRecord, getVaultPDA } =
    useVaultProgram();
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
      const vault = await fetchVaultConfig(publicKey);
      setVaultData(vault);
      if (vault) {
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

  const onRefresh = useCallback(async () => {
    await Promise.all([refresh(), loadVaultState()]);
  }, [refresh, loadVaultState]);

  const handleHeartbeat = useCallback(async () => {
    try {
      await confirmHeartbeat('active_tap');
      await loadVaultState();
    } catch {
      // Error handling — could show toast in future
    }
  }, [confirmHeartbeat, loadVaultState]);

  // Not connected state
  if (!connected) {
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.title}>Dead Man's Vault</Text>
        <Text style={styles.subtitle}>
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
      {/* Status Orb */}
      <StatusIndicator
        stage={escalationStage}
        isActive={isVaultSetup ? (vaultData?.active ?? false) : false}
      />

      {/* Escalation Banner */}
      <EscalationBanner stage={escalationStage} secondsRemaining={secondsRemaining} />

      {/* Heartbeat Button */}
      <HeartbeatButton
        onPress={handleHeartbeat}
        disabled={!isVaultSetup}
        loading={isConfirming}
        label={isVaultSetup ? 'Confirm Heartbeat' : 'Setup Required'}
      />

      {/* Heartbeat Status */}
      {heartbeatStatus && heartbeatStatus.lastHeartbeat > 0 && (
        <View style={styles.statsCard}>
          <Text style={styles.cardTitle}>Heartbeat Status</Text>
          <StatRow
            label="Last confirmed"
            value={timeAgo(heartbeatStatus.lastHeartbeat)}
          />
          <StatRow
            label="Method"
            value={heartbeatStatus.lastMethod}
          />
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
        <ActivityIndicator
          color={COLORS.accent}
          style={{ marginTop: SPACING.lg }}
        />
      ) : isVaultSetup ? (
        <View style={styles.statsCard}>
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
              escalationStage === 0 ? 'Normal' : escalationStage === 4 ? 'Executing' : 'Escalating'
            })`}
          />
        </View>
      ) : (
        <View style={styles.statsCard}>
          <Text style={styles.cardTitle}>No Vault Configured</Text>
          <Text style={styles.cardSubtitle}>
            Go to Setup tab to create your estate plan.
          </Text>
        </View>
      )}

      {/* Portfolio */}
      <View style={styles.statsCard}>
        <Text style={styles.cardTitle}>Portfolio</Text>
        <Text style={styles.portfolioValue}>{formatUsd(totalUsdValue)}</Text>
        <Text style={styles.portfolioSol}>
          {formatTokenAmount(solBalance, 4)} SOL
        </Text>

        {error && <Text style={styles.errorText}>{error}</Text>}

        {balances.map((token, i) => (
          <View key={i} style={styles.tokenRow}>
            <Text style={styles.tokenSymbol}>{token.symbol}</Text>
            <View style={styles.tokenRight}>
              <Text style={styles.tokenAmount}>
                {formatTokenAmount(token.amount, token.decimals > 4 ? 4 : token.decimals)}
              </Text>
              {token.usdValue > 0 && (
                <Text style={styles.tokenUsd}>{formatUsd(token.usdValue)}</Text>
              )}
            </View>
          </View>
        ))}
      </View>

      {/* Wallet Info */}
      <View style={styles.statsCard}>
        <StatRow
          label="Wallet"
          value={truncateAddress(publicKey?.toString() ?? '', 6)}
        />
      </View>

      <View style={{ height: SPACING.xxl }} />
    </ScrollView>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.statRow}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
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
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: COLORS.textPrimary,
    marginBottom: SPACING.sm,
  },
  subtitle: {
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
  statsCard: {
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
  portfolioValue: {
    fontSize: 32,
    fontWeight: '700',
    color: COLORS.textPrimary,
  },
  portfolioSol: {
    fontSize: 16,
    color: COLORS.textSecondary,
    marginBottom: SPACING.md,
  },
  tokenRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: SPACING.sm,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  tokenSymbol: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.textPrimary,
  },
  tokenRight: {
    alignItems: 'flex-end',
  },
  tokenAmount: {
    fontSize: 14,
    color: COLORS.textPrimary,
  },
  tokenUsd: {
    fontSize: 12,
    color: COLORS.textSecondary,
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
    marginTop: SPACING.xs,
  },
});
