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
import { useVaultStore } from '../store/useVaultStore';
import { useWallet } from '../hooks/useWallet';
import { useHeartbeatStore } from '../store/useHeartbeatStore';
import { KeyManager } from '../tee/KeyManager';
import { VaultTransactionService } from '../services/VaultTransactionService';
import { truncateAddress, formatDuration } from '../utils/formatting';
import { COLORS, SPACING, ESCALATION_DEFAULTS } from '../utils/constants';
import { StepIndicator } from '../components/StepIndicator';

export function EstateReviewScreen() {
  const navigation = useNavigation<any>();
  const { publicKey, signAndSendTransaction } = useWallet();
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
      // 1. Generate agent key if needed
      const keyManager = KeyManager.getInstance();
      let agentPubkeyStr = await keyManager.getAgentPublicKey();
      if (!agentPubkeyStr) {
        agentPubkeyStr = await keyManager.generateAgentKey();
      }
      const agentPubkey = new PublicKey(agentPubkeyStr);

      // 2. Build initialize_vault transaction
      const txService = new VaultTransactionService();
      const onChainBeneficiaries = beneficiaries.map((b) => ({
        wallet: new PublicKey(b.wallet.toBase58()),
        shareBps: b.shareBps,
        hasSpecificAssets: b.hasSpecificAssets,
      }));

      const tx = await txService.buildInitializeVaultTx(
        publicKey,
        agentPubkey,
        heartbeatConfig.intervalSeconds,
        gracePeriod,
        onChainBeneficiaries,
      );

      // 3. Set feePayer and blockhash
      tx.feePayer = publicKey;
      const { blockhash } = await txService.getConnection().getLatestBlockhash();
      tx.recentBlockhash = blockhash;

      // 4. Sign via MWA and send
      const { context } = await txService.getConnection().getLatestBlockhashAndContext();
      const txSig = await signAndSendTransaction(tx, context.slot);

      // 5. Fetch on-chain vault data and update store
      const vaultConfig = await txService.fetchVaultConfig(publicKey);
      if (vaultConfig) {
        setVaultConfig(vaultConfig);
      }
      setSetupComplete(true);

      Alert.alert('Success', `Vault registered on-chain!\n\nTx: ${txSig}`, [
        {
          text: 'OK',
          onPress: () => navigation.getParent()?.navigate('Status'),
        },
      ]);
    } catch (err: any) {
      Alert.alert('Registration Failed', err.message || 'Unknown error');
    } finally {
      setIsRegistering(false);
    }
  }, [
    publicKey,
    heartbeatConfig,
    beneficiaries,
    escalationConfig,
    gracePeriod,
    signAndSendTransaction,
    setSetupComplete,
    navigation,
  ]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <StepIndicator currentStep={4} totalSteps={4} />

      <Text style={styles.title}>Estate Plan Review</Text>
      <Text style={styles.subtitle}>
        Review your configuration before registering on-chain.
      </Text>

      {/* Heartbeat Config */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Heartbeat</Text>
        <Row
          label="Interval"
          value={heartbeatConfig ? formatDuration(heartbeatConfig.intervalSeconds) : 'Not set'}
        />
        <Row
          label="Methods"
          value={heartbeatConfig ? heartbeatConfig.methods.join(', ') : 'Not set'}
        />
      </View>

      {/* Beneficiaries */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>
          Beneficiaries ({beneficiaries.length})
        </Text>
        {beneficiaries.map((b, i) => (
          <View key={i} style={styles.beneficiaryRow}>
            <Text style={styles.beneficiaryLabel}>{b.label}</Text>
            <Text style={styles.beneficiaryDetail}>
              {truncateAddress(b.wallet.toString(), 4)} — {(b.shareBps / 100).toFixed(1)}%
            </Text>
          </View>
        ))}
      </View>

      {/* Grace Period */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Escalation Timeline</Text>
        <Row label="Stage 1 (Reminder)" value={formatDuration(escalationConfig.stage1Duration)} />
        <Row label="Stage 2 (Alert)" value={formatDuration(escalationConfig.stage2Duration)} />
        <Row label="Stage 3 (Warning)" value={formatDuration(escalationConfig.stage3Duration)} />
        <Row label="Total Grace Period" value={formatDuration(gracePeriod)} />
      </View>

      {/* Register button */}
      <TouchableOpacity
        style={[styles.registerButton, isRegistering && styles.registerDisabled]}
        onPress={handleRegister}
        disabled={isRegistering}
      >
        {isRegistering ? (
          <ActivityIndicator color={COLORS.textPrimary} />
        ) : (
          <Text style={styles.registerButtonText}>Activate Vault</Text>
        )}
      </TouchableOpacity>

      <Text style={styles.disclaimer}>
        This will create your vault on Solana Devnet. An agent key will be generated
        and stored securely on this device.
      </Text>

      <View style={{ height: SPACING.xxl }} />
    </ScrollView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
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
    fontSize: 20,
    fontWeight: '700',
    color: COLORS.textPrimary,
    marginBottom: SPACING.xs,
  },
  subtitle: {
    fontSize: 14,
    color: COLORS.textSecondary,
    marginBottom: SPACING.lg,
  },
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    padding: SPACING.md,
    marginBottom: SPACING.md,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.textPrimary,
    marginBottom: SPACING.sm,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: SPACING.xs,
  },
  rowLabel: {
    fontSize: 14,
    color: COLORS.textSecondary,
  },
  rowValue: {
    fontSize: 14,
    color: COLORS.textPrimary,
    fontWeight: '500',
  },
  beneficiaryRow: {
    paddingVertical: SPACING.xs,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  beneficiaryLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.textPrimary,
  },
  beneficiaryDetail: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginTop: 2,
  },
  registerButton: {
    backgroundColor: COLORS.accent,
    borderRadius: 12,
    paddingVertical: SPACING.md,
    alignItems: 'center',
    marginTop: SPACING.md,
  },
  registerDisabled: {
    opacity: 0.6,
  },
  registerButtonText: {
    color: COLORS.textPrimary,
    fontSize: 16,
    fontWeight: '700',
  },
  disclaimer: {
    fontSize: 12,
    color: COLORS.textMuted,
    textAlign: 'center',
    marginTop: SPACING.md,
    lineHeight: 18,
  },
});
