import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { PublicKey } from '@solana/web3.js';
import { useVaultStore } from '../store/useVaultStore';
import { useWallet } from '../hooks/useWallet';
import { isValidPublicKey, validateBeneficiaryShares } from '../utils/validation';
import { truncateAddress } from '../utils/formatting';
import { COLORS, SPACING } from '../utils/constants';
import { Beneficiary } from '../types/vault';
import { StepIndicator } from '../components/StepIndicator';

export function BeneficiaryScreen() {
  const navigation = useNavigation<any>();
  const { publicKey } = useWallet();
  const { beneficiaries, addBeneficiary, removeBeneficiary } = useVaultStore();

  const [label, setLabel] = useState('');
  const [walletAddress, setWalletAddress] = useState('');
  const [shareBps, setShareBps] = useState('');

  const totalBps = beneficiaries.reduce((sum, b) => sum + b.shareBps, 0);
  const isValid = validateBeneficiaryShares(beneficiaries.map((b) => b.shareBps));

  const handleAdd = useCallback(() => {
    const trimmedLabel = label.trim();
    const trimmedWallet = walletAddress.trim();
    const bps = parseInt(shareBps, 10);

    if (!trimmedLabel) {
      Alert.alert('Error', 'Please enter a label for this beneficiary.');
      return;
    }

    if (!isValidPublicKey(trimmedWallet)) {
      Alert.alert('Error', 'Invalid Solana wallet address.');
      return;
    }

    if (publicKey && trimmedWallet === publicKey.toBase58()) {
      Alert.alert('Error', 'Owner cannot be a beneficiary.');
      return;
    }

    if (isNaN(bps) || bps <= 0 || bps > 10000) {
      Alert.alert('Error', 'Share must be between 1 and 10,000 basis points.');
      return;
    }

    if (beneficiaries.length >= 20) {
      Alert.alert('Error', 'Maximum 20 beneficiaries allowed.');
      return;
    }

    const existing = beneficiaries.find(
      (b) => b.wallet.toString() === trimmedWallet,
    );
    if (existing) {
      Alert.alert('Error', 'This wallet is already a beneficiary.');
      return;
    }

    const newBeneficiary: Beneficiary = {
      label: trimmedLabel,
      wallet: new PublicKey(trimmedWallet),
      shareBps: bps,
      hasSpecificAssets: false,
    };

    addBeneficiary(newBeneficiary);
    setLabel('');
    setWalletAddress('');
    setShareBps('');
  }, [label, walletAddress, shareBps, publicKey, beneficiaries, addBeneficiary]);

  const handleRemove = useCallback(
    (wallet: string) => {
      Alert.alert('Remove Beneficiary', 'Are you sure?', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => removeBeneficiary(wallet) },
      ]);
    },
    [removeBeneficiary],
  );

  const handleContinue = useCallback(() => {
    if (!isValid) {
      Alert.alert('Error', 'Shares must sum to exactly 10,000 bps (100%).');
      return;
    }
    navigation.navigate('HeartbeatConfig');
  }, [isValid, navigation]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <StepIndicator currentStep={2} totalSteps={4} />

      {/* Allocation header */}
      <View style={styles.headerCard}>
        <Text style={styles.headerLabel}>Total Allocation</Text>
        <Text
          style={[
            styles.headerValue,
            { color: isValid ? COLORS.healthy : totalBps > 10000 ? COLORS.critical : COLORS.warning },
          ]}
        >
          {totalBps} / 10,000 bps ({(totalBps / 100).toFixed(1)}%)
        </Text>
      </View>

      {/* Beneficiary list */}
      {beneficiaries.map((b, i) => (
        <View key={i} style={styles.beneficiaryCard}>
          <View style={styles.beneficiaryInfo}>
            <Text style={styles.beneficiaryLabel}>{b.label}</Text>
            <Text style={styles.beneficiaryWallet}>
              {truncateAddress(b.wallet.toString(), 6)}
            </Text>
            <Text style={styles.beneficiaryShare}>
              {b.shareBps} bps ({(b.shareBps / 100).toFixed(1)}%)
            </Text>
          </View>
          <TouchableOpacity
            style={styles.removeButton}
            onPress={() => handleRemove(b.wallet.toString())}
          >
            <Text style={styles.removeButtonText}>X</Text>
          </TouchableOpacity>
        </View>
      ))}

      {/* Add beneficiary form */}
      <View style={styles.formCard}>
        <Text style={styles.formTitle}>Add Beneficiary</Text>

        <Text style={styles.inputLabel}>Label</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. Spouse, Child, Charity"
          placeholderTextColor={COLORS.textMuted}
          value={label}
          onChangeText={setLabel}
        />

        <Text style={styles.inputLabel}>Wallet Address</Text>
        <TextInput
          style={styles.input}
          placeholder="Solana public key"
          placeholderTextColor={COLORS.textMuted}
          value={walletAddress}
          onChangeText={setWalletAddress}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <Text style={styles.inputLabel}>Share (basis points, 10000 = 100%)</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. 5000 for 50%"
          placeholderTextColor={COLORS.textMuted}
          value={shareBps}
          onChangeText={setShareBps}
          keyboardType="numeric"
        />

        <TouchableOpacity style={styles.addButton} onPress={handleAdd}>
          <Text style={styles.addButtonText}>Add Beneficiary</Text>
        </TouchableOpacity>
      </View>

      {/* Continue button */}
      <TouchableOpacity
        style={[styles.continueButton, !isValid && styles.continueDisabled]}
        onPress={handleContinue}
        disabled={!isValid}
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
  headerCard: {
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    padding: SPACING.md,
    marginBottom: SPACING.md,
    alignItems: 'center',
  },
  headerLabel: {
    fontSize: 14,
    color: COLORS.textSecondary,
    marginBottom: SPACING.xs,
  },
  headerValue: {
    fontSize: 20,
    fontWeight: '700',
  },
  beneficiaryCard: {
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    padding: SPACING.md,
    marginBottom: SPACING.sm,
    flexDirection: 'row',
    alignItems: 'center',
  },
  beneficiaryInfo: {
    flex: 1,
  },
  beneficiaryLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.textPrimary,
  },
  beneficiaryWallet: {
    fontSize: 12,
    color: COLORS.textMuted,
    marginTop: 2,
  },
  beneficiaryShare: {
    fontSize: 14,
    color: COLORS.accent,
    marginTop: 4,
  },
  removeButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: COLORS.critical,
    justifyContent: 'center',
    alignItems: 'center',
  },
  removeButtonText: {
    color: COLORS.textPrimary,
    fontWeight: '700',
    fontSize: 14,
  },
  formCard: {
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    padding: SPACING.md,
    marginTop: SPACING.md,
  },
  formTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.textPrimary,
    marginBottom: SPACING.md,
  },
  inputLabel: {
    fontSize: 13,
    color: COLORS.textSecondary,
    marginBottom: SPACING.xs,
  },
  input: {
    backgroundColor: COLORS.bg,
    borderRadius: 8,
    padding: SPACING.sm,
    color: COLORS.textPrimary,
    fontSize: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginBottom: SPACING.md,
  },
  addButton: {
    backgroundColor: COLORS.accent,
    borderRadius: 8,
    paddingVertical: SPACING.sm,
    alignItems: 'center',
  },
  addButtonText: {
    color: COLORS.textPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
  continueButton: {
    backgroundColor: COLORS.healthy,
    borderRadius: 12,
    paddingVertical: SPACING.md,
    alignItems: 'center',
    marginTop: SPACING.lg,
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
