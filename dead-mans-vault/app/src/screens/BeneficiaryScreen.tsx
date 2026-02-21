import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  Linking,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { PublicKey } from '@solana/web3.js';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useVaultStore } from '../store/useVaultStore';
import { useWallet } from '../hooks/useWallet';
import { isValidPublicKey, validateBeneficiaryShares } from '../utils/validation';
import { truncateAddress } from '../utils/formatting';
import { COLORS, FONTS } from '../utils/constants';
import { Beneficiary } from '../types/vault';
import { StepIndicator } from '../components/StepIndicator';

export function BeneficiaryScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const fromSettings = route.params?.fromSettings ?? false;
  const { publicKey, signTransaction } = useWallet();
  const { beneficiaries, addBeneficiary, removeBeneficiary, updateBeneficiary } = useVaultStore();

  const [label, setLabel] = useState('');
  const [walletAddress, setWalletAddress] = useState('');
  const [sharePercent, setSharePercent] = useState('');
  const [editingWallet, setEditingWallet] = useState<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);

  const totalBps = beneficiaries.reduce((sum, b) => sum + b.shareBps, 0);
  const totalPercent = totalBps / 100;
  const isValid = validateBeneficiaryShares(beneficiaries.map((b) => b.shareBps));

  const resetForm = useCallback(() => {
    setLabel('');
    setWalletAddress('');
    setSharePercent('');
    setEditingWallet(null);
  }, []);

  const handleSave = useCallback(() => {
    const trimmedLabel = label.trim();
    const trimmedWallet = walletAddress.trim();
    const percent = parseFloat(sharePercent);

    if (!trimmedLabel) { Alert.alert('Error', 'Please enter a label for this beneficiary.'); return; }
    if (!isValidPublicKey(trimmedWallet)) { Alert.alert('Error', 'Invalid Solana wallet address.'); return; }
    if (publicKey && trimmedWallet === publicKey.toBase58()) { Alert.alert('Error', 'Owner cannot be a beneficiary.'); return; }
    if (isNaN(percent) || percent <= 0 || percent > 100) { Alert.alert('Error', 'Share must be between 0.01% and 100%.'); return; }

    const bps = Math.round(percent * 100);

    if (beneficiaries.length >= 20 && !editingWallet) { Alert.alert('Error', 'Maximum 20 beneficiaries allowed.'); return; }

    if (editingWallet) {
      if (trimmedWallet !== editingWallet) {
        const existing = beneficiaries.find((b) => b.wallet.toString() === trimmedWallet);
        if (existing) { Alert.alert('Error', 'This wallet is already a beneficiary.'); return; }
        removeBeneficiary(editingWallet);
        addBeneficiary({ label: trimmedLabel, wallet: new PublicKey(trimmedWallet), shareBps: bps, hasSpecificAssets: false });
      } else {
        updateBeneficiary(editingWallet, { label: trimmedLabel, shareBps: bps });
      }
    } else {
      const existing = beneficiaries.find((b) => b.wallet.toString() === trimmedWallet);
      if (existing) { Alert.alert('Error', 'This wallet is already a beneficiary.'); return; }
      addBeneficiary({ label: trimmedLabel, wallet: new PublicKey(trimmedWallet), shareBps: bps, hasSpecificAssets: false });
    }
    resetForm();
  }, [label, walletAddress, sharePercent, publicKey, beneficiaries, editingWallet, addBeneficiary, removeBeneficiary, updateBeneficiary, resetForm]);

  const handleEdit = useCallback((b: Beneficiary) => {
    setLabel(b.label);
    setWalletAddress(b.wallet.toString());
    setSharePercent((b.shareBps / 100).toString());
    setEditingWallet(b.wallet.toString());
  }, []);

  const handleRemove = useCallback((wallet: string) => {
    Alert.alert('Remove Beneficiary', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => { removeBeneficiary(wallet); if (editingWallet === wallet) resetForm(); } },
    ]);
  }, [removeBeneficiary, editingWallet, resetForm]);

  const handleContinue = useCallback(() => {
    if (!isValid) { Alert.alert('Error', 'Shares must sum to exactly 100%.'); return; }
    if (fromSettings) {
      Alert.alert(
        'Update Vault On-Chain?',
        `Update vault with ${beneficiaries.length} beneficiar${beneficiaries.length === 1 ? 'y' : 'ies'}. You will need to sign the transaction.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Update',
            onPress: async () => {
              if (!publicKey) return;
              setIsUpdating(true);
              try {
                const { VaultTransactionService } = require('../services/VaultTransactionService');
                const txService = new VaultTransactionService();
                const connection = txService.getConnection();

                const onChainBeneficiaries = beneficiaries.map((b: any) => ({
                  wallet: new PublicKey(b.wallet.toBase58()),
                  shareBps: b.shareBps,
                  hasSpecificAssets: b.hasSpecificAssets,
                }));

                const tx = await txService.buildUpdateVaultTx(publicKey, {
                  beneficiaries: onChainBeneficiaries,
                });
                tx.feePayer = publicKey;
                const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
                tx.recentBlockhash = blockhash;

                const signedTx = await signTransaction(tx);
                const txSig = await connection.sendRawTransaction(signedTx.serialize(), {
                  skipPreflight: false,
                  preflightCommitment: 'confirmed',
                });
                await connection.confirmTransaction(
                  { signature: txSig, blockhash, lastValidBlockHeight },
                  'confirmed',
                );

                const updatedVault = await txService.fetchVaultConfig(publicKey);
                if (updatedVault) {
                  useVaultStore.getState().setVaultConfig(updatedVault);
                }

                Alert.alert('Vault Updated', `Beneficiaries updated on-chain.\n\nTx: ${txSig.slice(0, 20)}...`, [
                  { text: 'View on Explorer', onPress: () => Linking.openURL(`https://explorer.solana.com/tx/${txSig}?cluster=devnet`) },
                  { text: 'OK', onPress: () => navigation.goBack() },
                ]);
              } catch (err: any) {
                const msg = err.message || String(err);
                if (msg.includes('CancellationException') || msg.includes('cancelled')) {
                  Alert.alert('Cancelled', 'Wallet signing was cancelled.');
                } else {
                  Alert.alert('Error', msg);
                }
              } finally {
                setIsUpdating(false);
              }
            },
          },
        ],
      );
      return;
    }
    navigation.navigate('HeartbeatConfig');
  }, [isValid, navigation, fromSettings, publicKey, beneficiaries, signTransaction]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <StepIndicator currentStep={2} totalSteps={4} labels={['Welcome', 'Beneficiaries', 'Heartbeat', 'Review']} />

      <Text style={styles.title}>Add Beneficiaries</Text>
      <Text style={styles.subtitle}>Choose who will receive your assets and in what proportions.</Text>

      {/* Share indicator */}
      <View style={[styles.shareIndicator, { backgroundColor: isValid ? 'rgba(0,255,163,0.08)' : 'rgba(239,68,68,0.08)', borderColor: isValid ? 'rgba(0,255,163,0.2)' : 'rgba(239,68,68,0.2)' }]}>
        <MaterialCommunityIcons name={isValid ? 'check-circle' : 'alert-circle'} size={16} color={isValid ? COLORS.accent : COLORS.critical} />
        <Text style={[styles.shareIndicatorText, { color: isValid ? COLORS.accent : COLORS.critical }]}>
          {isValid ? 'Shares balanced' : `${totalPercent.toFixed(0)}% allocated \u2014 ${(100 - totalPercent).toFixed(0)}% remaining`}
        </Text>
      </View>

      {/* Beneficiary cards */}
      {beneficiaries.map((b, i) => (
        <View key={i} style={styles.beneficiaryCard}>
          <View style={styles.cardHeader}>
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{i + 1}</Text>
            </View>
            <Text style={styles.cardHeaderLabel}>Beneficiary {i + 1}</Text>
            <View style={{ flex: 1 }} />
            <TouchableOpacity onPress={() => handleEdit(b)} style={styles.actionBtn}>
              <MaterialCommunityIcons name="pencil" size={14} color={COLORS.accent} />
            </TouchableOpacity>
            {beneficiaries.length > 1 && (
              <TouchableOpacity onPress={() => handleRemove(b.wallet.toString())} style={[styles.actionBtn, { marginLeft: 6 }]}>
                <MaterialCommunityIcons name="trash-can-outline" size={14} color={COLORS.critical} />
              </TouchableOpacity>
            )}
          </View>
          <View style={styles.cardBody}>
            <Text style={styles.beneficiaryName}>{b.label}</Text>
            <Text style={styles.beneficiaryAddress}>{truncateAddress(b.wallet.toString(), 6)}</Text>
          </View>
          <View style={styles.percentRow}>
            <View style={styles.percentBar}>
              <View style={[styles.percentFill, { width: `${Math.min(b.shareBps / 100, 100)}%` }]} />
            </View>
            <View style={styles.percentBadge}>
              <Text style={styles.percentBadgeText}>{(b.shareBps / 100).toFixed(b.shareBps % 100 === 0 ? 0 : 1)}%</Text>
            </View>
          </View>
        </View>
      ))}

      {/* Add/Edit form — hidden when 100% allocated unless editing */}
      {(totalBps < 10000 || editingWallet) && (
        <View style={styles.formCard}>
          <Text style={styles.formTitle}>{editingWallet ? 'Edit Beneficiary' : 'Add Beneficiary'}</Text>

          <Text style={styles.inputLabel}>LABEL</Text>
          <TextInput style={styles.input} placeholder="e.g. Spouse, Child" placeholderTextColor="rgba(255,255,255,0.2)" value={label} onChangeText={setLabel} />

          <Text style={styles.inputLabel}>WALLET ADDRESS</Text>
          <TextInput style={[styles.input, { fontFamily: FONTS.mono }]} placeholder="Solana public key" placeholderTextColor="rgba(255,255,255,0.2)" value={walletAddress} onChangeText={setWalletAddress} autoCapitalize="none" autoCorrect={false} />

          <Text style={styles.inputLabel}>SHARE (%)</Text>
          <TextInput style={styles.input} placeholder="e.g. 50" placeholderTextColor="rgba(255,255,255,0.2)" value={sharePercent} onChangeText={setSharePercent} keyboardType="decimal-pad" />

          <View style={styles.formActions}>
            {editingWallet && (
              <TouchableOpacity style={styles.cancelBtn} onPress={resetForm}>
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={[styles.saveBtn, editingWallet && { flex: 1 }]} onPress={handleSave}>
              <Text style={styles.saveBtnText}>{editingWallet ? 'Save Changes' : 'Add Beneficiary'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Footer */}
      <View style={styles.footer}>
        <TouchableOpacity style={styles.backBtn} onPress={() => fromSettings ? navigation.navigate('Settings') : navigation.goBack()}>
          <MaterialCommunityIcons name="arrow-left" size={18} color="rgba(255,255,255,0.5)" />
        </TouchableOpacity>
        <TouchableOpacity style={[styles.continueBtn, (!isValid || isUpdating) && { opacity: 0.4 }]} onPress={handleContinue} disabled={!isValid || isUpdating}>
          {isUpdating ? (
            <ActivityIndicator size="small" color={COLORS.bg} />
          ) : (
            <>
              <Text style={styles.continueBtnText}>{fromSettings ? 'Update Vault' : 'Continue'}</Text>
              <MaterialCommunityIcons name={fromSettings ? 'upload' : 'arrow-right'} size={16} color={COLORS.bg} />
            </>
          )}
        </TouchableOpacity>
      </View>

      <View style={{ height: 48 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  content: { paddingHorizontal: 16 },
  title: { fontSize: 20, fontWeight: '700', color: '#FFFFFF', fontFamily: FONTS.primaryBold, marginTop: 8 },
  subtitle: { fontSize: 13, color: 'rgba(255,255,255,0.55)', fontFamily: FONTS.primary, lineHeight: 20, marginBottom: 16 },
  shareIndicator: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 16, gap: 8 },
  shareIndicatorText: { fontSize: 12, fontWeight: '600', fontFamily: FONTS.primarySemiBold },
  beneficiaryCard: { backgroundColor: COLORS.surface, borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)', borderRadius: 16, padding: 16, marginBottom: 12 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  badge: { width: 22, height: 22, borderRadius: 11, backgroundColor: 'rgba(153,69,255,0.2)', borderWidth: 1, borderColor: 'rgba(153,69,255,0.3)', alignItems: 'center', justifyContent: 'center', marginRight: 8 },
  badgeText: { fontSize: 10, fontWeight: '700', color: '#9945FF', fontFamily: FONTS.primaryBold },
  cardHeaderLabel: { fontSize: 12, color: 'rgba(255,255,255,0.4)', fontWeight: '600', fontFamily: FONTS.primarySemiBold },
  actionBtn: { width: 28, height: 28, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.05)', alignItems: 'center', justifyContent: 'center' },
  cardBody: { marginBottom: 12 },
  beneficiaryName: { fontSize: 15, fontWeight: '700', color: '#FFFFFF', fontFamily: FONTS.primaryBold },
  beneficiaryAddress: { fontSize: 11, color: 'rgba(255,255,255,0.35)', fontFamily: FONTS.mono, marginTop: 2 },
  percentRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  percentBar: { flex: 1, height: 4, backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 2, overflow: 'hidden' },
  percentFill: { height: '100%', borderRadius: 2, backgroundColor: COLORS.solanaPurple },
  percentBadge: { backgroundColor: 'rgba(153,69,255,0.15)', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2 },
  percentBadgeText: { fontSize: 12, fontWeight: '700', color: '#9945FF', fontFamily: FONTS.primaryBold },
  formCard: { backgroundColor: COLORS.surface, borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)', borderRadius: 16, padding: 16, marginTop: 8 },
  formTitle: { fontSize: 15, fontWeight: '700', color: '#FFFFFF', fontFamily: FONTS.primaryBold, marginBottom: 16 },
  inputLabel: { fontSize: 10, fontWeight: '600', color: 'rgba(255,255,255,0.35)', letterSpacing: 1, marginBottom: 4, fontFamily: FONTS.primarySemiBold },
  input: { backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, color: '#FFFFFF', fontSize: 13, fontFamily: FONTS.primary, marginBottom: 16 },
  formActions: { flexDirection: 'row', gap: 8 },
  cancelBtn: { flex: 1, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  cancelBtnText: { color: 'rgba(255,255,255,0.55)', fontSize: 13, fontWeight: '600', fontFamily: FONTS.primarySemiBold },
  saveBtn: { flex: 1, backgroundColor: COLORS.accent, borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  saveBtnText: { color: COLORS.bg, fontSize: 13, fontWeight: '700', fontFamily: FONTS.primaryBold },
  footer: { flexDirection: 'row', gap: 12, marginTop: 24, paddingHorizontal: 4 },
  backBtn: { width: 48, height: 48, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center' },
  continueBtn: { flex: 1, flexDirection: 'row', backgroundColor: COLORS.accent, borderRadius: 16, paddingVertical: 16, alignItems: 'center', justifyContent: 'center', gap: 8 },
  continueBtnText: { color: COLORS.bg, fontSize: 15, fontWeight: '700', fontFamily: FONTS.primaryBold },
});
