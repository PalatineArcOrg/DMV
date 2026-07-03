import React, { useCallback, useRef, useMemo, useState, useEffect } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Linking, Alert, ActivityIndicator } from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '../hooks/useWallet';
import { useVaultStore } from '../store/useVaultStore';
import { useHeartbeatStore } from '../store/useHeartbeatStore';
import { useEscalationStore } from '../store/useEscalationStore';
import { validateBeneficiaryShares } from '../utils/validation';
import { truncateAddress, formatDuration } from '../utils/formatting';
import { COLORS, FONTS, SPACING, PROGRAM_ID, STAGE_CONFIG, ESCALATION_DEFAULTS } from '../utils/constants';
import { getExecutionSteps, clearDistributableSnapshot, clearTokenSnapshot } from '../db/executionRepo';

export function SetupWizardScreen() {
  const navigation = useNavigation<any>();
  const { publicKey, signTransaction } = useWallet();
  const { beneficiaries, isSetupComplete, setSetupComplete, setVaultConfig, vaultConfig } = useVaultStore();
  const heartbeatConfig = useHeartbeatStore((s) => s.config);
  const escalationStage = useEscalationStore((s) => s.state.stage);

  const skipAutoSync = useRef(false);

  // Ownership check: only show post-setup view if vault belongs to current wallet
  const isActuallySetup = useMemo(() => {
    if (!isSetupComplete) return false;
    if (!vaultConfig || !publicKey) return false;
    if (!vaultConfig.owner) return false;
    return vaultConfig.owner.toBase58() === publicKey.toBase58();
  }, [isSetupComplete, vaultConfig, publicKey]);

  const programPubkey = useMemo(() => new PublicKey(PROGRAM_ID), []);
  const vaultPda = useMemo(() => {
    if (!publicKey) return null;
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault'), publicKey.toBuffer()],
      programPubkey,
    );
    return pda;
  }, [publicKey, programPubkey]);

  const heartbeatDone = heartbeatConfig !== null;
  const beneficiariesDone = validateBeneficiaryShares(
    beneficiaries.map((b) => b.shareBps),
  );
  const hasPartialState = beneficiaries.length > 0 || heartbeatDone;

  const [isRevoking, setIsRevoking] = useState(false);
  const [isWithdrawing, setIsWithdrawing] = useState(false);
  const [hasVaultAssets, setHasVaultAssets] = useState(false);
  const [hasPastExecution, setHasPastExecution] = useState<boolean | null>(null);

  // Check if a past execution exists. A vault executed autonomously by the
  // notify-server leaves NO local execution-log steps, so an on-chain executed
  // vault counts too — otherwise the screen would fall through to the setup
  // wizard and show a stale "Configure Heartbeat" tick (synced from the vault).
  useEffect(() => {
    if (isActuallySetup || !publicKey) {
      setHasPastExecution(false);
      return;
    }
    if (vaultConfig?.executed) {
      setHasPastExecution(true);
      return;
    }
    (async () => {
      try {
        const steps = await getExecutionSteps(publicKey.toString());
        const completed = steps.filter((s) => s.status === 'completed');
        setHasPastExecution(completed.length > 0);
      } catch {
        setHasPastExecution(false);
      }
    })();
  }, [isActuallySetup, publicKey, vaultConfig?.executed]);

  // Check if vault has withdrawable assets
  useEffect(() => {
    if (!isActuallySetup || !publicKey) {
      setHasVaultAssets(false);
      return;
    }
    (async () => {
      try {
        const { VaultTransactionService } = require('../services/VaultTransactionService');
        const txService = new VaultTransactionService();
        const [vPda] = txService.getVaultPDA(publicKey);
        const tokens = await txService.getVaultTokenBalances(vPda);
        const info = await txService.getConnection().getAccountInfo(vPda);
        const rent = info ? await txService.getConnection().getMinimumBalanceForRentExemption(info.data.length) : 0;
        const availableSol = info ? info.lamports - rent : 0;
        setHasVaultAssets(tokens.length > 0 || availableSol > 0);
      } catch {
        setHasVaultAssets(false);
      }
    })();
  }, [isActuallySetup, publicKey]);

  const handleWithdrawAll = useCallback(async () => {
    if (!publicKey) return;
    Alert.alert(
      'Withdraw All Assets?',
      'This will return all deposited assets (tokens + SOL) from your vault to your wallet. The vault will remain active.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Withdraw All',
          onPress: async () => {
            setIsWithdrawing(true);
            try {
              const { VaultTransactionService } = require('../services/VaultTransactionService');
              const txService = new VaultTransactionService();
              const connection = txService.getConnection();

              const { instructions: withdrawIxs, assetCount } = await txService.buildWithdrawAllInstructions(publicKey);
              if (assetCount === 0) {
                Alert.alert('Nothing to Withdraw', 'Vault has no withdrawable assets.');
                return;
              }

              const txs = await txService.buildBatchedTxs(publicKey, withdrawIxs);
              let lastSig = '';
              for (const batchTx of txs) {
                batchTx.feePayer = publicKey;
                const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
                batchTx.recentBlockhash = blockhash;
                const signed = await signTransaction(batchTx);
                lastSig = await connection.sendRawTransaction(signed.serialize(), {
                  skipPreflight: false, preflightCommitment: 'confirmed',
                });
                await connection.confirmTransaction(
                  { signature: lastSig, blockhash, lastValidBlockHeight }, 'confirmed',
                );
              }

              setHasVaultAssets(false);
              Alert.alert('Assets Withdrawn', `${assetCount} asset(s) returned to your wallet.\n\nTx: ${lastSig.slice(0, 20)}...`, [
                { text: 'View on Explorer', onPress: () => Linking.openURL(`https://explorer.solana.com/tx/${lastSig}?cluster=devnet`) },
                { text: 'OK' },
              ]);
            } catch (err: any) {
              const msg = err.message || String(err);
              if (msg.includes('CancellationException') || msg.includes('cancelled')) {
                Alert.alert('Cancelled', 'Wallet signing was cancelled.');
              } else {
                Alert.alert('Error', msg);
              }
            } finally {
              setIsWithdrawing(false);
            }
          },
        },
      ],
    );
  }, [publicKey, signTransaction]);

  const handleStartOver = useCallback(async () => {
    skipAutoSync.current = true;
    useVaultStore.getState().resetForWalletSwitch();
    useHeartbeatStore.getState().reset();
    useEscalationStore.getState().reset();
    if (publicKey) {
      await clearDistributableSnapshot(publicKey.toString());
      await clearTokenSnapshot(publicKey.toString());
    }
    setHasPastExecution(false);
  }, [publicKey]);

  const handleRevoke = useCallback(async () => {
    if (!publicKey) return;
    Alert.alert(
      'Revoke Vault?',
      'This will withdraw all deposited assets, deactivate your vault on-chain, and clear all local data. This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Revoke',
          style: 'destructive',
          onPress: async () => {
            setIsRevoking(true);
            try {
              const { revokeVault, formatRevokeSummary } = require('../services/revokeVault');
              const result = await revokeVault(publicKey, signTransaction);
              const summary = formatRevokeSummary(result);

              const buttons = [
                ...summary.txs.slice(0, 2).map((t: { label: string; sig: string }, i: number) => ({
                  text: `View tx ${i + 1}`,
                  onPress: () => Linking.openURL(`https://explorer.solana.com/tx/${t.sig}?cluster=devnet`),
                })),
                { text: 'Done' },
              ];
              Alert.alert(summary.title, summary.message, buttons);
            } catch (err: any) {
              const { NotOwnerError } = require('../services/revokeVault');
              if (err instanceof NotOwnerError) {
                Alert.alert('Not Owner', 'This vault belongs to a different wallet.');
                return;
              }
              const msg = err.message || String(err);
              if (msg.includes('CancellationException') || msg.includes('cancelled')) {
                Alert.alert('Cancelled', 'Wallet signing was cancelled.');
              } else {
                Alert.alert('Error', msg);
              }
            } finally {
              setIsRevoking(false);
            }
          },
        },
      ],
    );
  }, [publicKey, signTransaction]);

  // On every focus: sync on-chain vault state + reset stack if needed
  useFocusEffect(
    useCallback(() => {
      if (!isActuallySetup && hasPastExecution === false) {
        navigation.popToTop();
      }

      // Skip auto-sync after "Start Over" or if vault was just revoked
      if (skipAutoSync.current) {
        skipAutoSync.current = false;
        return;
      }

      if (!isActuallySetup && publicKey && !useVaultStore.getState().isRevoked) {
        (async () => {
          try {
            const { VaultTransactionService } = require('../services/VaultTransactionService');
            const txService = new VaultTransactionService();
            const vault = await txService.fetchVaultConfig(publicKey);
            if (vault && vault.active) {
              setVaultConfig(vault);
            } else if (!vault && useVaultStore.getState().vaultConfig) {
              // Only clear if we previously had a vault (PDAs closed post-execution)
              // Don't clear during fresh setup — it would wipe local beneficiaries
              setVaultConfig(null);
            }
          } catch {
            // Non-fatal
          }
        })();
      }
    }, [isActuallySetup, hasPastExecution, publicKey, navigation, setVaultConfig]),
  );

  if (isActuallySetup) {
    const isExecuted = vaultConfig?.executed === true;
    const stageCfg = STAGE_CONFIG[escalationStage] ?? STAGE_CONFIG[0];
    const gracePeriod = vaultConfig?.gracePeriod?.toNumber?.()
      ?? (ESCALATION_DEFAULTS.stage1 + ESCALATION_DEFAULTS.stage2 + ESCALATION_DEFAULTS.stage3);

    // Executed vault: show clean summary
    if (isExecuted) {
      return (
        <ScrollView style={styles.container} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          {/* Executed Badge */}
          <View style={styles.executedBadge}>
            <MaterialCommunityIcons name="check-circle" size={24} color={COLORS.accent} />
            <Text style={styles.executedBadgeText}>Vault Executed</Text>
          </View>
          <Text style={styles.executedSubtext}>
            Your estate plan has been executed and assets distributed to your beneficiaries.
          </Text>

          {/* Beneficiaries (read-only) */}
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <MaterialCommunityIcons name="account-group" size={14} color="rgba(255,255,255,0.4)" />
              <Text style={styles.sectionLabel}>BENEFICIARIES</Text>
            </View>
            {beneficiaries.map((b, i) => (
              <View key={i} style={[styles.beneficiaryRow, i < beneficiaries.length - 1 && styles.rowBorder]}>
                <View style={styles.beneficiaryBadge}>
                  <Text style={styles.beneficiaryBadgeText}>{i + 1}</Text>
                </View>
                <View style={styles.beneficiaryInfo}>
                  <Text style={styles.beneficiaryName}>{b.label}</Text>
                  <Text style={styles.beneficiaryAddr}>{truncateAddress(b.wallet.toString(), 6)}</Text>
                </View>
                <View style={styles.percentBadge}>
                  <Text style={styles.percentText}>{(b.shareBps / 100).toFixed(1)}%</Text>
                </View>
              </View>
            ))}
          </View>

          {/* View Execution Log */}
          <TouchableOpacity
            style={styles.execLogBtn}
            onPress={() => navigation.getParent()?.navigate('Status', { screen: 'ExecutionLogs' })}
          >
            <MaterialCommunityIcons name="text-box-outline" size={16} color={COLORS.accent} />
            <Text style={styles.execLogBtnText}>View Execution Log</Text>
            <MaterialCommunityIcons name="chevron-right" size={14} color="rgba(255,255,255,0.3)" />
          </TouchableOpacity>

          {/* Set Up New Vault */}
          <TouchableOpacity style={styles.newVaultBtn} onPress={handleStartOver}>
            <MaterialCommunityIcons name="plus-circle-outline" size={16} color={COLORS.solanaPurple} />
            <Text style={[styles.execLogBtnText, { color: COLORS.solanaPurple }]}>Set Up New Vault</Text>
            <MaterialCommunityIcons name="chevron-right" size={14} color="rgba(255,255,255,0.3)" />
          </TouchableOpacity>

          <View style={{ height: SPACING.xxl }} />
        </ScrollView>
      );
    }

    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* Vault Status Header */}
        <View style={styles.statusHeader}>
          <View style={[styles.statusDot, { backgroundColor: stageCfg.color }]} />
          <Text style={[styles.statusLabel, { color: stageCfg.color }]}>{stageCfg.label}</Text>
          <Text style={styles.statusStageBadge}>{'\u00B7'} Stage {escalationStage}</Text>
        </View>

        {/* Beneficiaries Section */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <MaterialCommunityIcons name="account-group" size={14} color="rgba(255,255,255,0.4)" />
            <Text style={styles.sectionLabel}>BENEFICIARIES</Text>
          </View>
          {beneficiaries.length === 0 ? (
            <View style={styles.sectionRow}>
              <Text style={styles.warningText}>No beneficiaries configured</Text>
            </View>
          ) : (
            beneficiaries.map((b, i) => (
              <View key={i} style={[styles.beneficiaryRow, i < beneficiaries.length - 1 && styles.rowBorder]}>
                <View style={styles.beneficiaryBadge}>
                  <Text style={styles.beneficiaryBadgeText}>{i + 1}</Text>
                </View>
                <View style={styles.beneficiaryInfo}>
                  <Text style={styles.beneficiaryName}>{b.label}</Text>
                  <Text style={styles.beneficiaryAddr}>{truncateAddress(b.wallet.toString(), 6)}</Text>
                </View>
                <View style={styles.percentBadge}>
                  <Text style={styles.percentText}>{(b.shareBps / 100).toFixed(1)}%</Text>
                </View>
              </View>
            ))
          )}
        </View>

        {/* Heartbeat Settings */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <MaterialCommunityIcons name="clock-outline" size={14} color="rgba(255,255,255,0.4)" />
            <Text style={styles.sectionLabel}>HEARTBEAT SETTINGS</Text>
          </View>
          <View style={styles.gridRow}>
            <View style={styles.gridCell}>
              <Text style={styles.gridLabel}>Interval</Text>
              <Text style={styles.gridValue}>
                {heartbeatConfig ? formatDuration(heartbeatConfig.intervalSeconds) : vaultConfig ? formatDuration(vaultConfig.heartbeatInterval.toNumber()) : 'Not set'}
              </Text>
            </View>
            <View style={[styles.gridCell, styles.gridCellBorder]}>
              <Text style={styles.gridLabel}>Every</Text>
              <Text style={styles.gridValue}>
                {heartbeatConfig ? formatDuration(heartbeatConfig.intervalSeconds) : vaultConfig ? formatDuration(vaultConfig.heartbeatInterval.toNumber()) : '-'}
              </Text>
            </View>
            <View style={styles.gridCell}>
              <Text style={styles.gridLabel}>Grace Period</Text>
              <Text style={styles.gridValue}>
                {gracePeriod > 0 ? formatDuration(gracePeriod) : '-'}
              </Text>
            </View>
          </View>
        </View>

        {/* On-Chain Details */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <MaterialCommunityIcons name="flash" size={14} color="rgba(255,255,255,0.4)" />
            <Text style={styles.sectionLabel}>ON-CHAIN DETAILS</Text>
          </View>
          <View style={styles.detailsBody}>
            <DetailRow label="Network" value="Devnet" />
            <DetailRow
              label="Program"
              value={truncateAddress(PROGRAM_ID, 4)}
              mono
              onPress={() => Linking.openURL(`https://explorer.solana.com/address/${PROGRAM_ID}?cluster=devnet`)}
            />
            {vaultPda && (
              <DetailRow
                label="Your Vault"
                value={truncateAddress(vaultPda.toBase58(), 4)}
                mono
                onPress={() => Linking.openURL(`https://explorer.solana.com/address/${vaultPda.toBase58()}?cluster=devnet`)}
              />
            )}
            <DetailRow label="Execution" value="Permissionless" />
          </View>
        </View>

        {/* View Execution Log */}
        <TouchableOpacity
          style={styles.execLogBtn}
          onPress={() => navigation.getParent()?.navigate('Status', { screen: 'ExecutionLogs' })}
        >
          <MaterialCommunityIcons name="text-box-outline" size={16} color={COLORS.accent} />
          <Text style={styles.execLogBtnText}>View Execution Log</Text>
          <MaterialCommunityIcons name="chevron-right" size={14} color="rgba(255,255,255,0.3)" />
        </TouchableOpacity>

        {/* Edit Beneficiaries */}
        {vaultConfig && vaultConfig.active && !vaultConfig.executed && vaultConfig.isMutable !== false && (
          <TouchableOpacity
            style={styles.execLogBtn}
            onPress={() => navigation.navigate('Beneficiaries', { fromSettings: true })}
          >
            <MaterialCommunityIcons name="account-edit" size={16} color={COLORS.solanaPurple} />
            <Text style={[styles.execLogBtnText, { color: COLORS.solanaPurple }]}>Edit Beneficiaries</Text>
            <MaterialCommunityIcons name="chevron-right" size={14} color="rgba(255,255,255,0.3)" />
          </TouchableOpacity>
        )}

        {/* Specific bequests (carve out exact tokens / NFTs) */}
        {vaultConfig && vaultConfig.active && !vaultConfig.executed && vaultConfig.isMutable !== false && (
          <TouchableOpacity
            style={styles.execLogBtn}
            onPress={() => navigation.navigate('Bequests')}
          >
            <MaterialCommunityIcons name="gift-outline" size={16} color={COLORS.accent} />
            <Text style={[styles.execLogBtnText, { color: COLORS.accent }]}>
              {vaultConfig.hasAssetPlan ? 'Specific Bequests · Configured' : 'Manage Specific Bequests'}
            </Text>
            <MaterialCommunityIcons name="chevron-right" size={14} color="rgba(255,255,255,0.3)" />
          </TouchableOpacity>
        )}

        {/* Withdraw All */}
        {vaultConfig && vaultConfig.active && !vaultConfig.executed && hasVaultAssets && (
          <TouchableOpacity
            style={[styles.execLogBtn, styles.withdrawBtn]}
            onPress={handleWithdrawAll}
            disabled={isWithdrawing || isRevoking}
          >
            {isWithdrawing ? (
              <ActivityIndicator size="small" color={COLORS.warning} />
            ) : (
              <MaterialCommunityIcons name="bank-transfer-out" size={16} color={COLORS.warning} />
            )}
            <Text style={[styles.execLogBtnText, { color: COLORS.warning }]}>Withdraw All Assets</Text>
            <MaterialCommunityIcons name="chevron-right" size={14} color="rgba(255,255,255,0.3)" />
          </TouchableOpacity>
        )}

        {/* Revoke Vault */}
        {vaultConfig && vaultConfig.active && !vaultConfig.executed && vaultConfig.isMutable !== false && (
          <TouchableOpacity
            style={[styles.execLogBtn, styles.revokeBtn]}
            onPress={handleRevoke}
            disabled={isRevoking}
          >
            {isRevoking ? (
              <ActivityIndicator size="small" color={COLORS.critical} />
            ) : (
              <MaterialCommunityIcons name="shield-off" size={16} color={COLORS.critical} />
            )}
            <Text style={[styles.execLogBtnText, { color: COLORS.critical }]}>Revoke Vault</Text>
            <MaterialCommunityIcons name="chevron-right" size={14} color="rgba(255,255,255,0.2)" />
          </TouchableOpacity>
        )}

        <View style={{ height: SPACING.xxl }} />
      </ScrollView>
    );
  }

  // Vault PDAs closed after execution — show executed summary with log link
  if (hasPastExecution) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.executedBadge}>
          <MaterialCommunityIcons name="check-circle" size={24} color={COLORS.accent} />
          <Text style={styles.executedBadgeText}>Vault Executed</Text>
        </View>
        <Text style={styles.executedSubtext}>
          Your estate plan has been executed and assets distributed to your beneficiaries.
        </Text>

        <TouchableOpacity
          style={styles.execLogBtn}
          onPress={() => navigation.getParent()?.navigate('Status', { screen: 'ExecutionLogs' })}
        >
          <MaterialCommunityIcons name="text-box-outline" size={16} color={COLORS.accent} />
          <Text style={styles.execLogBtnText}>View Execution Log</Text>
          <MaterialCommunityIcons name="chevron-right" size={14} color="rgba(255,255,255,0.3)" />
        </TouchableOpacity>

        <TouchableOpacity style={styles.newVaultBtn} onPress={handleStartOver}>
          <MaterialCommunityIcons name="plus-circle-outline" size={16} color={COLORS.solanaPurple} />
          <Text style={[styles.execLogBtnText, { color: COLORS.solanaPurple }]}>Set Up New Vault</Text>
          <MaterialCommunityIcons name="chevron-right" size={14} color="rgba(255,255,255,0.3)" />
        </TouchableOpacity>

        <View style={{ height: SPACING.xxl }} />
      </ScrollView>
    );
  }

  // Not setup — navigate to Welcome screen
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Estate Plan Setup</Text>
      <Text style={styles.subtitle}>Complete each step to register your vault.</Text>

      <StepCard
        number={1}
        title="Add Beneficiaries"
        description="Add wallet addresses and percentage allocations."
        done={beneficiariesDone}
        onPress={() => navigation.navigate('Welcome')}
      />

      <StepCard
        number={2}
        title="Configure Heartbeat"
        description="Set your check-in interval."
        done={heartbeatDone}
        disabled={!beneficiariesDone}
        onPress={() => navigation.navigate('HeartbeatConfig')}
      />

      <StepCard
        number={3}
        title="Review & Register"
        description="Review your estate plan and register on-chain."
        done={false}
        disabled={!heartbeatDone || !beneficiariesDone}
        onPress={() => navigation.navigate('EstateReview')}
      />

      {hasPartialState && (
        <TouchableOpacity style={styles.startOverBtn} onPress={handleStartOver}>
          <MaterialCommunityIcons name="restart" size={14} color="rgba(255,255,255,0.4)" />
          <Text style={styles.startOverText}>Start Over</Text>
        </TouchableOpacity>
      )}

      <View style={{ height: SPACING.xxl }} />
    </ScrollView>
  );
}

function DetailRow({ label, value, mono, onPress }: { label: string; value: string; mono?: boolean; onPress?: () => void }) {
  const content = (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <Text style={[styles.detailValue, mono && { fontFamily: FONTS.mono }, onPress && { color: COLORS.accent }]}>{value}</Text>
        {onPress && <MaterialCommunityIcons name="open-in-new" size={10} color={COLORS.accent} />}
      </View>
    </View>
  );
  if (onPress) {
    return <TouchableOpacity onPress={onPress}>{content}</TouchableOpacity>;
  }
  return content;
}

function StepCard({
  number,
  title,
  description,
  done,
  disabled,
  onPress,
}: {
  number: number;
  title: string;
  description: string;
  done: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.stepCard, disabled && styles.stepCardDisabled]}
      onPress={onPress}
      disabled={disabled}
    >
      <View style={[styles.stepNumber, done && styles.stepNumberDone]}>
        <Text style={styles.stepNumberText}>
          {done ? '\u2713' : number}
        </Text>
      </View>
      <View style={styles.stepInfo}>
        <Text style={[styles.stepTitle, disabled && styles.stepTitleDisabled]}>
          {title}
        </Text>
        <Text style={styles.stepDescription}>{description}</Text>
      </View>
    </TouchableOpacity>
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
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: COLORS.textPrimary,
    fontFamily: FONTS.primaryBold,
    marginBottom: SPACING.sm,
  },
  subtitle: {
    fontSize: 14,
    color: COLORS.textSecondary,
    fontFamily: FONTS.primary,
    marginBottom: SPACING.lg,
  },
  // Post-setup: Vault status header
  statusHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 16,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  statusLabel: {
    fontSize: 16,
    fontWeight: '700',
    fontFamily: FONTS.primaryBold,
  },
  statusStageBadge: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.3)',
    fontFamily: FONTS.primary,
  },
  // Post-setup: Sections (reuse EstateReview styling)
  section: {
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    borderRadius: 16,
    marginBottom: 12,
    overflow: 'hidden',
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.4)',
    letterSpacing: 1,
    fontFamily: FONTS.primarySemiBold,
  },
  sectionRow: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  warningText: {
    fontSize: 12,
    color: COLORS.warning,
    fontFamily: FONTS.primary,
  },
  beneficiaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  rowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  beneficiaryBadge: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(153,69,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  beneficiaryBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#9945FF',
    fontFamily: FONTS.primaryBold,
  },
  beneficiaryInfo: { flex: 1 },
  beneficiaryName: {
    fontSize: 13,
    fontWeight: '600',
    color: '#FFFFFF',
    fontFamily: FONTS.primarySemiBold,
  },
  beneficiaryAddr: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.35)',
    fontFamily: FONTS.mono,
    marginTop: 1,
  },
  percentBadge: {
    backgroundColor: 'rgba(153,69,255,0.15)',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  percentText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#9945FF',
    fontFamily: FONTS.primaryBold,
  },
  gridRow: { flexDirection: 'row' },
  gridCell: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 12,
  },
  gridCellBorder: {
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  gridLabel: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.35)',
    fontFamily: FONTS.primary,
    marginBottom: 4,
  },
  gridValue: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.accent,
    fontFamily: FONTS.primaryBold,
  },
  detailsBody: { padding: 16 },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  detailLabel: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.4)',
    fontFamily: FONTS.primary,
  },
  detailValue: {
    fontSize: 12,
    color: '#FFFFFF',
    fontWeight: '500',
    fontFamily: FONTS.primaryMedium,
  },
  execLogBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 12,
  },
  execLogBtnText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '500',
    color: COLORS.accent,
    fontFamily: FONTS.primaryMedium,
  },
  withdrawBtn: {
    borderColor: 'rgba(245,158,11,0.15)',
  },
  revokeBtn: {
    borderColor: 'rgba(239,68,68,0.15)',
  },
  newVaultBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: 'rgba(153,69,255,0.2)',
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 12,
  },
  executedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
  },
  executedBadgeText: {
    fontSize: 22,
    fontWeight: '700',
    color: COLORS.accent,
    fontFamily: FONTS.primaryBold,
  },
  executedSubtext: {
    fontSize: 13,
    color: COLORS.textSecondary,
    fontFamily: FONTS.primary,
    marginBottom: 20,
    lineHeight: 19,
  },
  // Pre-setup step cards
  stepCard: {
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    padding: SPACING.md,
    marginBottom: SPACING.sm,
    flexDirection: 'row',
    alignItems: 'center',
  },
  stepCardDisabled: {
    opacity: 0.4,
  },
  stepNumber: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: COLORS.border,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: SPACING.md,
  },
  stepNumberDone: {
    backgroundColor: COLORS.accent,
  },
  stepNumberText: {
    color: COLORS.textPrimary,
    fontSize: 16,
    fontWeight: '700',
    fontFamily: FONTS.primaryBold,
  },
  stepInfo: {
    flex: 1,
  },
  stepTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.textPrimary,
    fontFamily: FONTS.primarySemiBold,
  },
  stepTitleDisabled: {
    color: COLORS.textMuted,
  },
  stepDescription: {
    fontSize: 13,
    color: COLORS.textSecondary,
    marginTop: 2,
    fontFamily: FONTS.primary,
  },
  startOverBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  startOverText: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.4)',
    fontFamily: FONTS.primary,
  },
});
