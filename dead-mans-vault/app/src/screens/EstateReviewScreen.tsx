import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { PublicKey } from '@solana/web3.js';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useVaultStore } from '../store/useVaultStore';
import { useWallet } from '../hooks/useWallet';
import { useHeartbeatStore } from '../store/useHeartbeatStore';
import { KeyManager } from '../tee/KeyManager';
import { VaultTransactionService } from '../services/VaultTransactionService';
import { truncateAddress, formatDuration } from '../utils/formatting';
import { COLORS, FONTS, PROGRAM_ID } from '../utils/constants';
import { StepIndicator } from '../components/StepIndicator';

export function EstateReviewScreen() {
  const navigation = useNavigation<any>();
  const { publicKey, signTransaction } = useWallet();
  const { beneficiaries, escalationConfig, setSetupComplete, setVaultConfig } = useVaultStore();
  const heartbeatConfig = useHeartbeatStore((s) => s.config);

  const [isRegistering, setIsRegistering] = useState(false);

  const gracePeriod =
    escalationConfig.stage1Duration +
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

      const [vaultPda] = txService.getVaultPDA(publicKey);
      const existingAccount = await connection.getAccountInfo(vaultPda);
      if (existingAccount && existingAccount.data.length > 0) {
        const existingVault = await txService.fetchVaultConfig(publicKey);
        if (existingVault) {
          setVaultConfig(existingVault);
        } else {
          setSetupComplete(true);
        }
        Alert.alert('Success', 'Vault already active on-chain! Synced to device.', [
          { text: 'OK', onPress: () => { navigation.popToTop(); navigation.getParent()?.navigate('Status'); } },
        ]);
        return;
      }

      const onChainBeneficiaries = beneficiaries.map((b) => ({
        wallet: new PublicKey(b.wallet.toBase58()),
        shareBps: b.shareBps,
        hasSpecificAssets: b.hasSpecificAssets,
      }));

      const tx = await txService.buildInitializeVaultTx(
        publicKey, agentPubkey, heartbeatConfig.intervalSeconds, gracePeriod, onChainBeneficiaries,
      );

      tx.feePayer = publicKey;
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;

      const signedTx = await signTransaction(tx);
      const txSig = await connection.sendRawTransaction(signedTx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' });
      await connection.confirmTransaction({ signature: txSig, blockhash, lastValidBlockHeight }, 'confirmed');

      const vaultConfig = await txService.fetchVaultConfig(publicKey);
      if (vaultConfig) {
        setVaultConfig(vaultConfig);
      } else {
        setSetupComplete(true);
      }

      Alert.alert('Success', `Vault registered on-chain!\n\nTx: ${txSig}`, [
        { text: 'OK', onPress: () => { navigation.popToTop(); navigation.getParent()?.navigate('Status'); } },
      ]);
    } catch (err: any) {
      const msg = err.message || String(err);
      if (msg.includes('already in use') || msg.includes('custom program error: 0x0')) {
        try {
          const recoveryService = new VaultTransactionService();
          const vault = await recoveryService.fetchVaultConfig(publicKey);
          if (vault) setVaultConfig(vault);
          setSetupComplete(true);
          Alert.alert('Success', 'Vault already active on-chain! Synced to device.', [
            { text: 'OK', onPress: () => { navigation.popToTop(); navigation.getParent()?.navigate('Status'); } },
          ]);
          return;
        } catch { /* fallthrough */ }
      }
      if (msg.includes('CancellationException') || msg.includes('cancelled')) {
        Alert.alert('Wallet Cancelled', 'The wallet signing was cancelled. Please try again.');
      } else {
        Alert.alert('Registration Failed', msg);
      }
    } finally {
      setIsRegistering(false);
    }
  }, [publicKey, heartbeatConfig, beneficiaries, escalationConfig, gracePeriod, signTransaction, setSetupComplete, setVaultConfig, navigation]);

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
            <Text style={styles.gridValue}>{heartbeatConfig ? `${heartbeatConfig.intervalSeconds / 86400}d` : '-'}</Text>
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
          <DetailRow label="Network" value="Devnet" />
          <DetailRow label="Program" value={truncateAddress(PROGRAM_ID, 4)} mono />
          <DetailRow label="Est. Fee" value="~0.01 SOL" />
          <DetailRow label="Execution" value="Agent Key (TEE)" />
        </View>
      </View>

      {/* Legal Warning */}
      <View style={styles.legalBox}>
        <Text style={styles.legalText}>
          {'\u26A0\uFE0F'} This vault is irreversible once execution begins. Missed heartbeats will trigger the escalation process. Only the owner can revoke.
        </Text>
      </View>

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
              <MaterialCommunityIcons name="shield-check" size={18} color={COLORS.bg} />
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
});
