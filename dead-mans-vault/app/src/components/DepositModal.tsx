import React, { useState } from 'react';
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
} from 'react-native';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS, FONTS } from '../utils/constants';

interface DepositModalProps {
  visible: boolean;
  walletBalance: number;
  onConfirm: (lamports: number) => Promise<void>;
  onClose: () => void;
}

export function DepositModal({ visible, walletBalance, onConfirm, onClose }: DepositModalProps) {
  const [amount, setAmount] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const feeReserve = 0.01 * LAMPORTS_PER_SOL;
  const maxSol = Math.max(0, (walletBalance - feeReserve) / LAMPORTS_PER_SOL);
  const parsedAmount = parseFloat(amount) || 0;
  const isValid = parsedAmount > 0 && parsedAmount <= maxSol;

  const handleMax = () => {
    setAmount(maxSol > 0 ? maxSol.toFixed(4) : '0');
  };

  const handleConfirm = async () => {
    if (!isValid) return;
    setIsSubmitting(true);
    try {
      const lamports = Math.floor(parsedAmount * LAMPORTS_PER_SOL);
      await onConfirm(lamports);
      setAmount('');
      onClose();
    } catch {
      // Error handled by parent
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    if (isSubmitting) return;
    setAmount('');
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
            <MaterialCommunityIcons name="bank-transfer-in" size={20} color={COLORS.accent} />
            <Text style={styles.title}>Deposit SOL</Text>
          </View>

          <Text style={styles.description}>
            Deposit SOL into your vault PDA. This is the amount that will be distributed to your beneficiaries.
          </Text>

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
            <Text style={styles.infoLabel}>Wallet balance</Text>
            <Text style={styles.infoValue}>{(walletBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL</Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Available (excl. fees)</Text>
            <Text style={styles.infoValue}>{maxSol.toFixed(4)} SOL</Text>
          </View>

          {parsedAmount > maxSol && parsedAmount > 0 && (
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
                <Text style={styles.confirmBtnText}>Deposit</Text>
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
  description: { fontSize: 12, color: 'rgba(255,255,255,0.5)', lineHeight: 18, fontFamily: FONTS.primary, marginBottom: 20 },
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
