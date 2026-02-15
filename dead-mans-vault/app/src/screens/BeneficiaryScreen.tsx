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
import { MaterialIcons } from '@expo/vector-icons';
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
  const { beneficiaries, addBeneficiary, removeBeneficiary, updateBeneficiary } = useVaultStore();

  const [label, setLabel] = useState('');
  const [walletAddress, setWalletAddress] = useState('');
  const [sharePercent, setSharePercent] = useState('');
  const [editingWallet, setEditingWallet] = useState<string | null>(null);

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

    if (isNaN(percent) || percent <= 0 || percent > 100) {
      Alert.alert('Error', 'Share must be between 0.01% and 100%.');
      return;
    }

    const bps = Math.round(percent * 100);

    if (beneficiaries.length >= 20 && !editingWallet) {
      Alert.alert('Error', 'Maximum 20 beneficiaries allowed.');
      return;
    }

    if (editingWallet) {
      // Editing existing — if wallet changed, check for duplicates
      if (trimmedWallet !== editingWallet) {
        const existing = beneficiaries.find(
          (b) => b.wallet.toString() === trimmedWallet,
        );
        if (existing) {
          Alert.alert('Error', 'This wallet is already a beneficiary.');
          return;
        }
        // Remove old, add new (wallet address changed)
        removeBeneficiary(editingWallet);
        addBeneficiary({
          label: trimmedLabel,
          wallet: new PublicKey(trimmedWallet),
          shareBps: bps,
          hasSpecificAssets: false,
        });
      } else {
        updateBeneficiary(editingWallet, {
          label: trimmedLabel,
          shareBps: bps,
        });
      }
    } else {
      const existing = beneficiaries.find(
        (b) => b.wallet.toString() === trimmedWallet,
      );
      if (existing) {
        Alert.alert('Error', 'This wallet is already a beneficiary.');
        return;
      }

      addBeneficiary({
        label: trimmedLabel,
        wallet: new PublicKey(trimmedWallet),
        shareBps: bps,
        hasSpecificAssets: false,
      });
    }

    resetForm();
  }, [label, walletAddress, sharePercent, publicKey, beneficiaries, editingWallet, addBeneficiary, removeBeneficiary, updateBeneficiary, resetForm]);

  const handleEdit = useCallback((b: Beneficiary) => {
    setLabel(b.label);
    setWalletAddress(b.wallet.toString());
    setSharePercent((b.shareBps / 100).toString());
    setEditingWallet(b.wallet.toString());
  }, []);

  const handleRemove = useCallback(
    (wallet: string) => {
      Alert.alert('Remove Beneficiary', 'Are you sure?', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            removeBeneficiary(wallet);
            if (editingWallet === wallet) resetForm();
          },
        },
      ]);
    },
    [removeBeneficiary, editingWallet, resetForm],
  );

  const handleContinue = useCallback(() => {
    if (!isValid) {
      Alert.alert('Error', 'Shares must sum to exactly 100%.');
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
            { color: isValid ? COLORS.healthy : totalPercent > 100 ? COLORS.critical : COLORS.warning },
          ]}
        >
          {totalPercent.toFixed(totalPercent % 1 === 0 ? 0 : 2)}% / 100%
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
              {(b.shareBps / 100).toFixed(b.shareBps % 100 === 0 ? 0 : 2)}%
            </Text>
          </View>
          <View style={styles.cardActions}>
            <TouchableOpacity
              style={styles.editButton}
              onPress={() => handleEdit(b)}
            >
              <MaterialIcons name="edit" size={16} color={COLORS.accent} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.removeButton}
              onPress={() => handleRemove(b.wallet.toString())}
            >
              <MaterialIcons name="close" size={16} color={COLORS.textPrimary} />
            </TouchableOpacity>
          </View>
        </View>
      ))}

      {/* Add/Edit beneficiary form */}
      <View style={styles.formCard}>
        <Text style={styles.formTitle}>
          {editingWallet ? 'Edit Beneficiary' : 'Add Beneficiary'}
        </Text>

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

        <Text style={styles.inputLabel}>Share (%)</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. 50 for 50%"
          placeholderTextColor={COLORS.textMuted}
          value={sharePercent}
          onChangeText={setSharePercent}
          keyboardType="decimal-pad"
        />

        <View style={styles.formActions}>
          {editingWallet && (
            <TouchableOpacity style={styles.cancelButton} onPress={resetForm}>
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[styles.addButton, editingWallet ? styles.addButtonFlex : null]}
            onPress={handleSave}
          >
            <Text style={styles.addButtonText}>
              {editingWallet ? 'Save Changes' : 'Add Beneficiary'}
            </Text>
          </TouchableOpacity>
        </View>
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
    fontWeight: '600',
  },
  cardActions: {
    flexDirection: 'row',
    gap: SPACING.sm,
  },
  editButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: COLORS.accent + '20',
    justifyContent: 'center',
    alignItems: 'center',
  },
  removeButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: COLORS.critical,
    justifyContent: 'center',
    alignItems: 'center',
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
  formActions: {
    flexDirection: 'row',
    gap: SPACING.sm,
  },
  cancelButton: {
    flex: 1,
    backgroundColor: COLORS.bg,
    borderRadius: 8,
    paddingVertical: SPACING.sm,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  cancelButtonText: {
    color: COLORS.textSecondary,
    fontSize: 14,
    fontWeight: '600',
  },
  addButton: {
    backgroundColor: COLORS.accent,
    borderRadius: 8,
    paddingVertical: SPACING.sm,
    alignItems: 'center',
    flex: 0,
    width: '100%',
  },
  addButtonFlex: {
    flex: 1,
    width: undefined,
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
