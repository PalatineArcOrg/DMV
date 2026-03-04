import React, { useState, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Modal,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS, FONTS } from '../utils/constants';
import type { TokenBalance } from '../types/defi';

interface VaultTokenBalance {
  mint: PublicKey;
  amount: number;
  decimals: number;
  uiAmount: number;
  symbol?: string;
}

interface DepositModalProps {
  visible: boolean;
  walletBalance: number;
  tokenBalances: TokenBalance[];
  vaultSolBalance: number;
  vaultTokenBalances: VaultTokenBalance[];
  onConfirmSol: (lamports: number) => Promise<void>;
  onConfirmToken: (mint: PublicKey, rawAmount: number, decimals: number) => Promise<void>;
  onWithdrawSol: (lamports: number) => Promise<void>;
  onWithdrawToken: (mint: PublicKey, rawAmount: number, decimals: number) => Promise<void>;
  onClose: () => void;
}

export function DepositModal({
  visible, walletBalance, tokenBalances,
  vaultSolBalance, vaultTokenBalances,
  onConfirmSol, onConfirmToken,
  onWithdrawSol, onWithdrawToken,
  onClose,
}: DepositModalProps) {
  const [mode, setMode] = useState<'deposit' | 'withdraw'>('deposit');
  const [selectedAsset, setSelectedAsset] = useState<'SOL' | string>('SOL');
  const [amount, setAmount] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isWithdraw = mode === 'withdraw';

  // Deposit: wallet tokens. Withdraw: vault tokens.
  const splTokens = useMemo(() => {
    if (isWithdraw) {
      return vaultTokenBalances.filter((t) => t.uiAmount > 0).map((t) => ({
        mint: t.mint,
        symbol: t.symbol ?? t.mint.toString().slice(0, 6),
        amount: t.uiAmount,
        decimals: t.decimals,
      }));
    }
    return tokenBalances.filter((t) => t.symbol !== 'SOL' && t.amount > 0);
  }, [isWithdraw, tokenBalances, vaultTokenBalances]);

  const selectedToken = selectedAsset !== 'SOL'
    ? splTokens.find((t) => t.mint.toString() === selectedAsset)
    : null;

  const feeReserve = 0.01 * LAMPORTS_PER_SOL;
  const maxAmount = selectedAsset === 'SOL'
    ? isWithdraw
      ? Math.max(0, vaultSolBalance / LAMPORTS_PER_SOL)
      : Math.max(0, (walletBalance - feeReserve) / LAMPORTS_PER_SOL)
    : (selectedToken?.amount ?? 0);

  const symbol = selectedAsset === 'SOL' ? 'SOL' : (selectedToken?.symbol ?? '???');
  const parsedAmount = parseFloat(amount) || 0;
  const isValid = parsedAmount > 0 && parsedAmount <= maxAmount;

  const handleMax = () => {
    setAmount(maxAmount > 0 ? (selectedAsset === 'SOL' ? maxAmount.toFixed(4) : String(maxAmount)) : '0');
  };

  const handleSelect = (asset: 'SOL' | string) => {
    setSelectedAsset(asset);
    setAmount('');
  };

  const handleModeSwitch = (newMode: 'deposit' | 'withdraw') => {
    setMode(newMode);
    setSelectedAsset('SOL');
    setAmount('');
  };

  const handleConfirm = async () => {
    if (!isValid) return;
    setIsSubmitting(true);
    try {
      if (isWithdraw) {
        if (selectedAsset === 'SOL') {
          await onWithdrawSol(Math.floor(parsedAmount * LAMPORTS_PER_SOL));
        } else if (selectedToken) {
          const rawAmount = Math.floor(parsedAmount * 10 ** selectedToken.decimals);
          await onWithdrawToken(selectedToken.mint, rawAmount, selectedToken.decimals);
        }
      } else {
        if (selectedAsset === 'SOL') {
          await onConfirmSol(Math.floor(parsedAmount * LAMPORTS_PER_SOL));
        } else if (selectedToken) {
          const rawAmount = Math.floor(parsedAmount * 10 ** selectedToken.decimals);
          await onConfirmToken(selectedToken.mint, rawAmount, selectedToken.decimals);
        }
      }
      setAmount('');
      onClose();
    } catch {
      // Error propagated from parent handlers
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    if (isSubmitting) return;
    setAmount('');
    setSelectedAsset('SOL');
    setMode('deposit');
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.overlay}
      >
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={handleClose} />
        <View style={styles.container}>
          <View style={styles.header}>
            <MaterialCommunityIcons
              name={isWithdraw ? 'bank-transfer-out' : 'bank-transfer-in'}
              size={20}
              color={isWithdraw ? COLORS.warning : COLORS.accent}
            />
            <Text style={styles.title}>{isWithdraw ? 'Withdraw from Vault' : 'Deposit to Vault'}</Text>
          </View>

          {/* Mode Toggle */}
          <View style={styles.modeToggle}>
            <TouchableOpacity
              style={[styles.modeTab, mode === 'deposit' && styles.modeTabActive]}
              onPress={() => handleModeSwitch('deposit')}
              disabled={isSubmitting}
            >
              <Text style={[styles.modeTabText, mode === 'deposit' && styles.modeTabTextActive]}>Deposit</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modeTab, mode === 'withdraw' && styles.modeTabActiveWithdraw]}
              onPress={() => handleModeSwitch('withdraw')}
              disabled={isSubmitting}
            >
              <Text style={[styles.modeTabText, mode === 'withdraw' && styles.modeTabTextActiveWithdraw]}>Withdraw</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.description}>
            {isWithdraw
              ? 'Select an asset and amount to withdraw from your vault PDA back to your wallet.'
              : 'Select an asset and amount to deposit into your vault PDA for distribution to beneficiaries.'}
          </Text>

          {/* Asset Selector */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.assetScroll}>
            <TouchableOpacity
              style={[styles.assetChip, selectedAsset === 'SOL' && styles.assetChipSelected]}
              onPress={() => handleSelect('SOL')}
            >
              <Text style={[styles.assetChipText, selectedAsset === 'SOL' && styles.assetChipTextSelected]}>
                SOL
              </Text>
            </TouchableOpacity>
            {splTokens.map((t) => {
              const mintStr = t.mint.toString();
              const isSelected = selectedAsset === mintStr;
              return (
                <TouchableOpacity
                  key={mintStr}
                  style={[styles.assetChip, isSelected && styles.assetChipSelected]}
                  onPress={() => handleSelect(mintStr)}
                >
                  <Text style={[styles.assetChipText, isSelected && styles.assetChipTextSelected]}>
                    {t.symbol}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          {/* Amount Input */}
          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              value={amount}
              onChangeText={setAmount}
              placeholder="0.0"
              placeholderTextColor="rgba(255,255,255,0.2)"
              keyboardType="decimal-pad"
              autoFocus
              editable={!isSubmitting}
            />
            <TouchableOpacity style={styles.maxBtn} onPress={handleMax} disabled={isSubmitting}>
              <Text style={styles.maxBtnText}>MAX</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>
              {isWithdraw ? `Vault ${symbol}` : `Available ${symbol}`}
            </Text>
            <Text style={styles.infoValue}>
              {selectedAsset === 'SOL'
                ? isWithdraw
                  ? `${(vaultSolBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`
                  : `${(walletBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`
                : `${selectedToken?.amount ?? 0} ${symbol}`}
            </Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>{isWithdraw ? 'Withdraw amount' : 'Deposit amount'}</Text>
            <Text style={styles.infoValue}>
              {parsedAmount > 0 ? `${parsedAmount} ${symbol}` : '-'}
            </Text>
          </View>

          {parsedAmount > maxAmount && parsedAmount > 0 && (
            <Text style={styles.errorText}>Amount exceeds available balance</Text>
          )}

          <View style={styles.buttonRow}>
            <TouchableOpacity style={styles.cancelBtn} onPress={handleClose} disabled={isSubmitting}>
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.confirmBtn, (!isValid || isSubmitting) && { opacity: 0.5 }]}
              onPress={handleConfirm}
              disabled={!isValid || isSubmitting}
            >
              {isSubmitting ? (
                <ActivityIndicator color={COLORS.bg} size="small" />
              ) : (
                <Text style={styles.confirmBtnText}>{isWithdraw ? 'Withdraw' : 'Deposit'} {symbol}</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.7)' },
  container: {
    width: '88%',
    maxWidth: 360,
    backgroundColor: COLORS.surface,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    padding: 24,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  title: { fontSize: 17, fontWeight: '700', color: '#FFFFFF', fontFamily: FONTS.primaryBold },
  description: { fontSize: 12, color: 'rgba(255,255,255,0.5)', lineHeight: 18, fontFamily: FONTS.primary, marginBottom: 16 },
  modeToggle: {
    flexDirection: 'row',
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 10,
    padding: 3,
    marginBottom: 14,
  },
  modeTab: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 8,
  },
  modeTabActive: {
    backgroundColor: 'rgba(0,255,163,0.15)',
  },
  modeTabActiveWithdraw: {
    backgroundColor: 'rgba(245,158,11,0.15)',
  },
  modeTabText: { fontSize: 13, fontWeight: '600', color: 'rgba(255,255,255,0.4)', fontFamily: FONTS.primarySemiBold },
  modeTabTextActive: { color: COLORS.accent },
  modeTabTextActiveWithdraw: { color: COLORS.warning },
  assetScroll: { marginBottom: 16, flexGrow: 0 },
  assetChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    backgroundColor: 'rgba(255,255,255,0.04)',
    marginRight: 8,
  },
  assetChipSelected: {
    borderColor: COLORS.accent,
    backgroundColor: 'rgba(0,255,163,0.1)',
  },
  assetChipText: { fontSize: 13, fontWeight: '600', color: 'rgba(255,255,255,0.5)', fontFamily: FONTS.primarySemiBold },
  assetChipTextSelected: { color: COLORS.accent },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16 },
  input: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 18,
    fontWeight: '600',
    color: '#FFFFFF',
    fontFamily: FONTS.primarySemiBold,
  },
  maxBtn: {
    backgroundColor: 'rgba(0,255,163,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(0,255,163,0.3)',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  maxBtnText: { fontSize: 12, fontWeight: '700', color: COLORS.accent, fontFamily: FONTS.primaryBold },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  infoLabel: { fontSize: 12, color: 'rgba(255,255,255,0.4)', fontFamily: FONTS.primary },
  infoValue: { fontSize: 12, color: 'rgba(255,255,255,0.7)', fontFamily: FONTS.mono },
  errorText: { fontSize: 11, color: COLORS.critical, fontFamily: FONTS.primary, marginTop: 4, marginBottom: 8 },
  buttonRow: { flexDirection: 'row', gap: 12, marginTop: 20 },
  cancelBtn: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  cancelBtnText: { fontSize: 14, fontWeight: '600', color: 'rgba(255,255,255,0.5)', fontFamily: FONTS.primarySemiBold },
  confirmBtn: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    backgroundColor: COLORS.accent,
  },
  confirmBtnText: { fontSize: 14, fontWeight: '700', color: COLORS.bg, fontFamily: FONTS.primaryBold },
});
