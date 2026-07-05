import React, { useState, useCallback } from 'react';
import { explorerTx, networkLabel } from '../utils/rpcConfig';

import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Linking,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useVaultStore } from '../store/useVaultStore';
import { useWallet } from '../hooks/useWallet';
import { useHeartbeatStore } from '../store/useHeartbeatStore';
import { useDemoStore } from '../store/useDemoStore';
import { KeyManager } from '../tee/KeyManager';
import { VaultTransactionService } from '../services/VaultTransactionService';
import { useEscalationStore } from '../store/useEscalationStore';
import { clearHeartbeatHistory, recordHeartbeat } from '../db/heartbeatRepo';
import { clearDistributableSnapshot, clearTokenSnapshot } from '../db/executionRepo';
import { truncateAddress, formatDuration } from '../utils/formatting';
import { COLORS, FONTS, PROGRAM_ID, KEEPER_BOUNTY_LAMPORTS } from '../utils/constants';
import { StepIndicator } from '../components/StepIndicator';

// Agent only needs heartbeat fees now — execution is permissionless and nothing
// refunds the agent on autonomous execution (D7).
const AGENT_FUNDING_LAMPORTS = Math.floor(0.005 * LAMPORTS_PER_SOL);

export function EstateReviewScreen() {
  const navigation = useNavigation<any>();
  const { publicKey, signTransaction } = useWallet();
  const { beneficiaries, escalationConfig, setSetupComplete, setVaultConfig } = useVaultStore();
  const heartbeatConfig = useHeartbeatStore((s) => s.config);

  const [isRegistering, setIsRegistering] = useState(false);
  const [isMutable, setIsMutable] = useState(true);

  const isDemoMode = useDemoStore((s) => s.isDemoMode);

  const gracePeriod = isDemoMode
    ? 90 // 30s per escalation stage in demo mode
    : escalationConfig.stage1Duration +
      escalationConfig.stage2Duration +
      escalationConfig.stage3Duration;

  const handleRegister = useCallback(async () => {
    if (!publicKey || !heartbeatConfig) {
      Alert.alert('Error', 'Wallet and heartbeat config are required.');
      return;
    }
    if (beneficiaries.length === 0) {
      Alert.alert('Error', 'At least one beneficiary is required.');
      return;
    }

    setIsRegistering(true);
    try {
      const keyManager = KeyManager.getInstance();
      let agentPubkeyStr = await keyManager.getAgentPublicKey();
      if (!agentPubkeyStr) {
        agentPubkeyStr = await keyManager.generateAgentKey();
      }
      const agentPubkey = new PublicKey(agentPubkeyStr);

      const txService = new VaultTransactionService();
      const connection = txService.getConnection();

      const onChainBeneficiaries = beneficiaries.map((b) => ({
        wallet: new PublicKey(b.wallet.toBase58()),
        shareBps: b.shareBps,
      }));

      // Pre-flight balance check — vault rent (~0.008) + agent funding (0.005) + creation fee (0.01) + keeper reward (0.005) ≈ 0.028, plus buffer
      const ownerBalance = await connection.getBalance(publicKey);
      const MIN_BALANCE = 0.035 * LAMPORTS_PER_SOL;
      if (ownerBalance < MIN_BALANCE) {
        Alert.alert('Insufficient Balance', `You need at least 0.035 SOL to activate the vault (~0.008 rent + 0.005 agent funding + 0.01 creation fee + 0.005 keeper reward ≈ 0.028, plus a small buffer).\n\nCurrent balance: ${(ownerBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
        setIsRegistering(false);
        return;
      }

      // Check for existing on-chain vault
      const [vaultPda] = txService.getVaultPDA(publicKey);
      const existingAccount = await connection.getAccountInfo(vaultPda);
      let vaultTx: Transaction;

      if (existingAccount && existingAccount.data.length > 0) {
        let existingVault = await txService.fetchVaultConfig(publicKey);
        if (!existingVault && existingAccount.data.length >= 92) {
          existingVault = VaultTransactionService.parseVaultConfigRaw(existingAccount);
        }
        if (existingVault) {
          if (existingVault.active && !existingVault.executed) {
            useVaultStore.getState().setRevoked(false);
            setVaultConfig(existingVault);
            Alert.alert('Vault Active', 'An active vault already exists on-chain. Synced to device.', [
              { text: 'OK', onPress: () => { navigation.popToTop(); navigation.getParent()?.navigate('Status'); } },
            ]);
            return;
          } else if (existingVault.executed) {
            vaultTx = await txService.buildCloseExecutedAndReinitVaultTx(
              publicKey, agentPubkey, heartbeatConfig.intervalSeconds, gracePeriod, onChainBeneficiaries, isMutable,
            );
          } else {
            vaultTx = await txService.buildCloseAndReinitVaultTx(
              publicKey, agentPubkey, heartbeatConfig.intervalSeconds, gracePeriod, onChainBeneficiaries, isMutable,
            );
          }
        } else {
          vaultTx = await txService.buildInitializeVaultTx(
            publicKey, agentPubkey, heartbeatConfig.intervalSeconds, gracePeriod, onChainBeneficiaries, isMutable,
          );
        }
      } else {
        vaultTx = await txService.buildInitializeVaultTx(
          publicKey, agentPubkey, heartbeatConfig.intervalSeconds, gracePeriod, onChainBeneficiaries, isMutable,
        );
      }

      // Fund agent key so it can pay TX fees for heartbeats + execution
      // Skip if agent already has sufficient balance (e.g. reusing key after revoke)
      const agentBalance = await connection.getBalance(agentPubkey);
      const fundingNeeded = Math.max(0, AGENT_FUNDING_LAMPORTS - agentBalance);
      if (fundingNeeded > 0) {
        vaultTx.add(
          SystemProgram.transfer({
            fromPubkey: publicKey,
            toPubkey: agentPubkey,
            lamports: fundingNeeded,
          }),
        );
      }

      // Reserve the keeper bounty in the vault so it's available to pay whoever
      // cranks the distribution. It's carved out on-chain (begin_execution), so it
      // doesn't reduce beneficiary payouts — it's a separate reserve on top.
      vaultTx.add(
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: vaultPda,
          lamports: KEEPER_BOUNTY_LAMPORTS,
        }),
      );

      vaultTx.feePayer = publicKey;
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      vaultTx.recentBlockhash = blockhash;

      const signedVaultTx = await signTransaction(vaultTx);

      const vaultTxSig = await connection.sendRawTransaction(
        (signedVaultTx as Transaction).serialize(),
        { skipPreflight: false, preflightCommitment: 'confirmed' },
      );
      await connection.confirmTransaction(
        { signature: vaultTxSig, blockhash, lastValidBlockHeight },
        'confirmed',
      );

      // Reset stale state from any previous vault session
      // This prevents the EscalationService from immediately jumping to Stage 4
      // Execution logs are preserved so the user can still review past executions —
      // they get cleared by ExecutionService when a new execution actually starts.
      const ownerWallet = publicKey.toString();
      await clearHeartbeatHistory();
      await clearDistributableSnapshot(ownerWallet);
      await clearTokenSnapshot(ownerWallet);
      await recordHeartbeat('active_tap');
      useEscalationStore.getState().reset();

      // Sync vault config to store
      const vaultConfig = await txService.fetchVaultConfig(publicKey);
      if (vaultConfig) {
        useVaultStore.getState().setRevoked(false);
        setVaultConfig(vaultConfig);
      } else {
        setSetupComplete(true);
      }

      Alert.alert(
        'Vault Activated',
        `Vault created on Solana ${networkLabel()}.\n\n` +
        `Deposit SOL into the vault from the Dashboard to set up distribution.\n\n` +
        `Tx: ${vaultTxSig.slice(0, 20)}...`,
        [
          {
            text: 'View on Explorer',
            onPress: () => {
              Linking.openURL(explorerTx(vaultTxSig));
              navigation.popToTop();
              navigation.getParent()?.navigate('Status');
            },
          },
          {
            text: 'OK',
            onPress: () => {
              navigation.popToTop();
              navigation.getParent()?.navigate('Status');
            },
          },
        ],
      );
    } catch (err: any) {
      const msg = err.message || String(err);
      if (msg.includes('already in use') || msg.includes('custom program error: 0x0')) {
        try {
          const recoveryService = new VaultTransactionService();
          const vault = await recoveryService.fetchVaultConfig(publicKey);
          if (vault) {
            if (vault.active && !vault.executed) {
              useVaultStore.getState().setRevoked(false);
              setVaultConfig(vault);
              Alert.alert('Vault Active', 'An active vault already exists on-chain. Synced to device.', [
                { text: 'OK', onPress: () => { navigation.popToTop(); navigation.getParent()?.navigate('Status'); } },
              ]);
              return;
            } else if (!vault.active && !vault.executed) {
              Alert.alert('Retry Required', 'A revoked vault was found. Please try activating again to clean it up.');
              return;
            }
          }
        } catch { /* fallthrough */ }
      }
      if (msg.includes('CancellationException') || msg.includes('cancelled')) {
        Alert.alert('Wallet Cancelled', 'The wallet signing was cancelled.', [
          { text: 'OK', onPress: () => navigation.popToTop() },
        ]);
        return;
      } else {
        Alert.alert('Registration Failed', msg);
      }
    } finally {
      setIsRegistering(false);
    }
  }, [publicKey, heartbeatConfig, beneficiaries, escalationConfig, gracePeriod, signTransaction, setSetupComplete, setVaultConfig, navigation, isMutable]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <StepIndicator currentStep={4} totalSteps={4} labels={['Welcome', 'Beneficiaries', 'Heartbeat', 'Review']} />

      <Text style={styles.title}>Review & Activate</Text>
      <Text style={styles.subtitle}>Double-check your vault configuration before registering on-chain.</Text>

      {/* Beneficiaries Section */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <MaterialCommunityIcons name="account-group" size={14} color="rgba(255,255,255,0.4)" />
          <Text style={styles.sectionLabel}>BENEFICIARIES</Text>
        </View>
        {beneficiaries.length === 0 ? (
          <View style={styles.sectionRow}>
            <Text style={styles.warningText}>No beneficiaries added</Text>
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

      {/* Heartbeat Section */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <MaterialCommunityIcons name="clock-outline" size={14} color="rgba(255,255,255,0.4)" />
          <Text style={styles.sectionLabel}>HEARTBEAT SETTINGS</Text>
        </View>
        <View style={styles.gridRow}>
          <View style={styles.gridCell}>
            <Text style={styles.gridLabel}>Interval</Text>
            <Text style={styles.gridValue}>{heartbeatConfig ? formatDuration(heartbeatConfig.intervalSeconds) : 'Not set'}</Text>
          </View>
          <View style={[styles.gridCell, styles.gridCellBorder]}>
            <Text style={styles.gridLabel}>Every</Text>
            <Text style={styles.gridValue}>{heartbeatConfig ? (heartbeatConfig.intervalSeconds < 86400 ? `${heartbeatConfig.intervalSeconds}s` : `${heartbeatConfig.intervalSeconds / 86400}d`) : '-'}</Text>
          </View>
          <View style={styles.gridCell}>
            <Text style={styles.gridLabel}>Grace Period</Text>
            <Text style={styles.gridValue}>{formatDuration(gracePeriod)}</Text>
          </View>
        </View>
      </View>

      {/* On-chain Details */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <MaterialCommunityIcons name="flash" size={14} color="rgba(255,255,255,0.4)" />
          <Text style={styles.sectionLabel}>ON-CHAIN DETAILS</Text>
        </View>
        <View style={styles.detailsBody}>
          <DetailRow label="Network" value={networkLabel()} />
          <DetailRow label="Program" value={truncateAddress(PROGRAM_ID, 4)} mono />
          <DetailRow label="Vault Rent" value="~0.008 SOL" />
          <DetailRow label="Agent Funding" value="~0.005 SOL" />
          <DetailRow label="Creation Fee" value="0.01 SOL" />
          <DetailRow label="Keeper Reward" value="0.005 SOL" />
          <DetailRow label="Total Est. Cost" value="~0.028 SOL" />
          <DetailRow label="Distribution" value="Per-beneficiary on-chain" />
        </View>
      </View>

      {/* Vault Mutability */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <MaterialCommunityIcons name="lock-outline" size={14} color="rgba(255,255,255,0.4)" />
          <Text style={styles.sectionLabel}>VAULT TYPE</Text>
        </View>
        <View style={styles.mutabilityBody}>
          <TouchableOpacity
            style={[styles.mutabilityOption, isMutable && styles.mutabilityOptionActive]}
            onPress={() => setIsMutable(true)}
          >
            <View style={[styles.radioOuter, isMutable && styles.radioOuterActive]}>
              {isMutable && <View style={styles.radioInner} />}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.mutabilityTitle, isMutable && { color: COLORS.accent }]}>Mutable</Text>
              <Text style={styles.mutabilityDesc}>Can be revoked or updated after activation</Text>
            </View>
            <MaterialCommunityIcons name="lock-open-variant-outline" size={18} color={isMutable ? COLORS.accent : 'rgba(255,255,255,0.2)'} />
          </TouchableOpacity>
          <View style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.06)' }} />
          <TouchableOpacity
            style={[styles.mutabilityOption, !isMutable && styles.mutabilityOptionImmutable]}
            onPress={() => {
              Alert.alert(
                'Make Vault Immutable?',
                'An immutable vault CANNOT be revoked or updated after activation. The vault will execute when heartbeats cease, no matter what. This is permanent.',
                [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Make Immutable', style: 'destructive', onPress: () => setIsMutable(false) },
                ],
              );
            }}
          >
            <View style={[styles.radioOuter, !isMutable && styles.radioOuterImmutable]}>
              {!isMutable && <View style={[styles.radioInner, { backgroundColor: COLORS.critical }]} />}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.mutabilityTitle, !isMutable && { color: COLORS.critical }]}>Immutable</Text>
              <Text style={styles.mutabilityDesc}>Cannot be revoked or updated. Permanent.</Text>
            </View>
            <MaterialCommunityIcons name="lock" size={18} color={!isMutable ? COLORS.critical : 'rgba(255,255,255,0.2)'} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Legal Warning */}
      <View style={[styles.legalBox, !isMutable && { borderColor: 'rgba(239,68,68,0.3)', backgroundColor: 'rgba(239,68,68,0.1)' }]}>
        <Text style={styles.legalText}>
          {!isMutable
            ? '\u26A0\uFE0F IMMUTABLE: This vault cannot be cancelled once activated. It will execute when heartbeats cease. There is no undo.'
            : '\u26A0\uFE0F This vault is irreversible once execution begins. Missed heartbeats will trigger the escalation process. Only the owner can revoke.'
          }
        </Text>
      </View>

      {/* Demo Warning Banner */}
      {isDemoMode && (
        <View style={styles.demoBanner}>
          <MaterialCommunityIcons name="flash" size={14} color="#F59E0B" />
          <Text style={styles.demoBannerText}>
            DEMO MODE: Vault uses 30s heartbeat + 90s grace period. Execution is REAL and IRREVERSIBLE.
          </Text>
        </View>
      )}

      {/* Footer */}
      <View style={styles.footer}>
        {!isRegistering && (
          <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()}>
            <MaterialCommunityIcons name="arrow-left" size={18} color="rgba(255,255,255,0.5)" />
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={[styles.activateBtn, isRegistering && { opacity: 0.8 }]}
          onPress={handleRegister}
          disabled={isRegistering}
        >
          {isRegistering ? (
            <View style={styles.activatingRow}>
              <ActivityIndicator color={COLORS.bg} size="small" />
              <Text style={styles.activateBtnText}>Activating...</Text>
            </View>
          ) : (
            <>
              <MaterialCommunityIcons name="check-circle" size={18} color={COLORS.bg} />
              <Text style={styles.activateBtnText}>Activate Vault</Text>
            </>
          )}
        </TouchableOpacity>
      </View>

      <View style={{ height: 48 }} />
    </ScrollView>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={[styles.detailValue, mono && { fontFamily: FONTS.mono }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  content: { paddingHorizontal: 16 },
  title: { fontSize: 20, fontWeight: '700', color: '#FFFFFF', fontFamily: FONTS.primaryBold, marginTop: 8 },
  subtitle: { fontSize: 13, color: 'rgba(255,255,255,0.55)', fontFamily: FONTS.primary, lineHeight: 20, marginBottom: 20 },
  section: { backgroundColor: COLORS.surface, borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)', borderRadius: 16, marginBottom: 12, overflow: 'hidden' },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)' },
  sectionLabel: { fontSize: 11, fontWeight: '600', color: 'rgba(255,255,255,0.4)', letterSpacing: 1, fontFamily: FONTS.primarySemiBold },
  sectionRow: { paddingHorizontal: 16, paddingVertical: 12 },
  warningText: { fontSize: 12, color: COLORS.warning, fontFamily: FONTS.primary },
  beneficiaryRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)' },
  beneficiaryBadge: { width: 32, height: 32, borderRadius: 16, backgroundColor: 'rgba(153,69,255,0.2)', alignItems: 'center', justifyContent: 'center' },
  beneficiaryBadgeText: { fontSize: 11, fontWeight: '700', color: '#9945FF', fontFamily: FONTS.primaryBold },
  beneficiaryInfo: { flex: 1 },
  beneficiaryName: { fontSize: 13, fontWeight: '600', color: '#FFFFFF', fontFamily: FONTS.primarySemiBold },
  beneficiaryAddr: { fontSize: 10, color: 'rgba(255,255,255,0.35)', fontFamily: FONTS.mono, marginTop: 1 },
  percentBadge: { backgroundColor: 'rgba(153,69,255,0.15)', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  percentText: { fontSize: 12, fontWeight: '700', color: '#9945FF', fontFamily: FONTS.primaryBold },
  gridRow: { flexDirection: 'row' },
  gridCell: { flex: 1, alignItems: 'center', paddingVertical: 12 },
  gridCellBorder: { borderLeftWidth: 1, borderRightWidth: 1, borderColor: 'rgba(255,255,255,0.06)' },
  gridLabel: { fontSize: 10, color: 'rgba(255,255,255,0.35)', fontFamily: FONTS.primary, marginBottom: 4 },
  gridValue: { fontSize: 13, fontWeight: '700', color: COLORS.accent, fontFamily: FONTS.primaryBold },
  detailsBody: { padding: 16 },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  detailLabel: { fontSize: 12, color: 'rgba(255,255,255,0.4)', fontFamily: FONTS.primary },
  detailValue: { fontSize: 12, color: '#FFFFFF', fontWeight: '500', fontFamily: FONTS.primaryMedium },
  legalBox: { backgroundColor: 'rgba(239,68,68,0.06)', borderWidth: 1, borderColor: 'rgba(239,68,68,0.15)', borderRadius: 12, padding: 12, marginBottom: 24 },
  legalText: { fontSize: 11, color: 'rgba(255,255,255,0.55)', lineHeight: 18, fontFamily: FONTS.primary },
  footer: { flexDirection: 'row', gap: 12, paddingHorizontal: 4 },
  backBtn: { width: 48, height: 48, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center' },
  activateBtn: { flex: 1, flexDirection: 'row', backgroundColor: COLORS.accent, borderRadius: 16, paddingVertical: 16, alignItems: 'center', justifyContent: 'center', gap: 8 },
  activateBtnText: { color: COLORS.bg, fontSize: 15, fontWeight: '700', fontFamily: FONTS.primaryBold },
  activatingRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  mutabilityBody: { overflow: 'hidden' },
  mutabilityOption: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  mutabilityOptionActive: { backgroundColor: 'rgba(0,212,180,0.05)' },
  mutabilityOptionImmutable: { backgroundColor: 'rgba(239,68,68,0.05)' },
  mutabilityTitle: { fontSize: 13, fontWeight: '600', color: 'rgba(255,255,255,0.6)', fontFamily: FONTS.primarySemiBold },
  mutabilityDesc: { fontSize: 11, color: 'rgba(255,255,255,0.35)', fontFamily: FONTS.primary, marginTop: 1 },
  radioOuter: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: 'rgba(255,255,255,0.15)', alignItems: 'center', justifyContent: 'center' },
  radioOuterActive: { borderColor: COLORS.accent },
  radioOuterImmutable: { borderColor: COLORS.critical },
  radioInner: { width: 10, height: 10, borderRadius: 5, backgroundColor: COLORS.accent },
  demoBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(245,158,11,0.08)', borderWidth: 1, borderColor: 'rgba(245,158,11,0.2)', borderRadius: 12, padding: 12, marginBottom: 16 },
  demoBannerText: { flex: 1, fontSize: 11, color: '#F59E0B', lineHeight: 16, fontFamily: FONTS.primary, fontWeight: '600' },
});
