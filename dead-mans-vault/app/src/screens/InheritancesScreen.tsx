import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { PublicKey } from '@solana/web3.js';
import { useFocusEffect } from '@react-navigation/native';
import { COLORS, FONTS, NOTIFY_URL } from '../utils/constants';
import { useWallet } from '../hooks/useWallet';
import { VaultTransactionService } from '../services/VaultTransactionService';
import { ClaimService } from '../services/ClaimService';

type Status = 'active' | 'warning' | 'claimable' | 'executed';

interface Inheritance {
  vault: string;
  owner: string;
  shareBps: number;
  status: Status;
  secondsToDeadline: number | null;
}

const STATUS_META: Record<Status, { label: string; color: string }> = {
  active: { label: 'Active', color: COLORS.accent },
  warning: { label: 'Overdue', color: COLORS.warning },
  claimable: { label: 'Claimable', color: COLORS.critical },
  executed: { label: 'Distributed', color: COLORS.textDim },
};

function truncate(addr: string): string {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function sharePct(bps: number): string {
  const pct = bps / 100;
  return `${pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(2)}%`;
}

function formatCountdown(s: number | null): string {
  if (s === null) return '';
  if (s <= 0) return 'grace elapsed';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h left`;
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m left`;
}

export function InheritancesScreen() {
  const { publicKey, signTransaction } = useWallet();

  const [items, setItems] = useState<Inheritance[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [importText, setImportText] = useState('');
  const [importing, setImporting] = useState(false);
  const [claimingOwner, setClaimingOwner] = useState<string | null>(null);
  const [progress, setProgress] = useState('');

  const load = useCallback(async () => {
    if (!publicKey) {
      setItems([]);
      return;
    }
    if (!NOTIFY_URL) return;
    try {
      const res = await fetch(`${NOTIFY_URL}/inheritances?wallet=${publicKey.toBase58()}`);
      if (!res.ok) return;
      const data = await res.json();
      const list: Inheritance[] = (data.inheritances || []).map((i: any) => ({
        vault: i.vault,
        owner: i.owner,
        shareBps: i.shareBps,
        status: i.status,
        secondsToDeadline: i.secondsToDeadline ?? null,
      }));
      // Preserve any manually-imported vaults not returned by the server.
      setItems((prev) => {
        const serverOwners = new Set(list.map((l) => l.owner));
        const keptImports = prev.filter((p) => !serverOwners.has(p.owner));
        return [...list, ...keptImports];
      });
    } catch {
      // leave the current list in place on a transient error
    }
  }, [publicKey]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load().finally(() => setLoading(false));
    }, [load]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const onImport = useCallback(async () => {
    if (!publicKey) return;
    let ownerPk: PublicKey;
    try {
      ownerPk = new PublicKey(importText.trim());
    } catch {
      Alert.alert('Invalid address', 'Enter a valid owner wallet address.');
      return;
    }
    setImporting(true);
    try {
      const svc = new VaultTransactionService();
      const config = await svc.fetchVaultConfig(ownerPk);
      if (!config) {
        Alert.alert('No vault found', 'That address does not have a vault.');
        return;
      }
      const me = publicKey.toBase58();
      const benef = config.beneficiaries.find(
        (b: any) => new PublicKey(b.wallet).toBase58() === me,
      );
      if (!benef) {
        Alert.alert('Not a beneficiary', 'You are not a beneficiary of that vault.');
        return;
      }
      const deadline = await svc.getOnChainDeadline(ownerPk);
      const now = Math.floor(Date.now() / 1000);
      let status: Status = 'active';
      let secondsToDeadline: number | null = null;
      if (config.executed) status = 'executed';
      else if (deadline !== null) {
        secondsToDeadline = Math.max(0, deadline - now);
        status = now >= deadline ? 'claimable' : 'active';
      }
      const entry: Inheritance = {
        vault: svc.getVaultPDA(ownerPk)[0].toBase58(),
        owner: ownerPk.toBase58(),
        shareBps: benef.shareBps,
        status,
        secondsToDeadline,
      };
      setItems((prev) => [entry, ...prev.filter((p) => p.owner !== entry.owner)]);
      setImportText('');
    } catch {
      Alert.alert('Could not load vault', 'Please try again.');
    } finally {
      setImporting(false);
    }
  }, [importText, publicKey]);

  const onClaim = useCallback(
    (item: Inheritance) => {
      if (!publicKey) return;
      Alert.alert(
        'Distribute this estate?',
        'This runs the full distribution to ALL beneficiaries of this vault (not just your share) — assets go directly to each beneficiary per the on-chain plan. You only pay the network fees. Continue?',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Distribute',
            style: 'destructive',
            onPress: async () => {
              setClaimingOwner(item.owner);
              setProgress('Preparing…');
              try {
                const owner = new PublicKey(item.owner);
                await ClaimService.runClaim(owner, publicKey, signTransaction, (label) =>
                  setProgress(label),
                );
                Alert.alert('Estate distributed', 'All beneficiaries have received their assets.');
                await load();
              } catch (e: any) {
                Alert.alert('Distribution failed', e?.message ?? 'The transaction was not completed.');
              } finally {
                setClaimingOwner(null);
                setProgress('');
              }
            },
          },
        ],
      );
    },
    [publicKey, signTransaction, load],
  );

  const renderCard = (item: Inheritance) => {
    const meta = STATUS_META[item.status];
    const isClaiming = claimingOwner === item.owner;
    return (
      <View key={item.vault} style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={{ flex: 1 }}>
            <Text style={styles.cardLabel}>FROM</Text>
            <Text style={styles.cardOwner}>{truncate(item.owner)}</Text>
          </View>
          <View style={[styles.pill, { borderColor: meta.color }]}>
            <View style={[styles.pillDot, { backgroundColor: meta.color }]} />
            <Text style={[styles.pillText, { color: meta.color }]}>{meta.label}</Text>
          </View>
        </View>

        <View style={styles.cardRow}>
          <Text style={styles.cardRowLabel}>Your share</Text>
          <Text style={styles.cardRowValue}>{sharePct(item.shareBps)}</Text>
        </View>
        {item.status !== 'executed' && item.status !== 'claimable' && item.secondsToDeadline !== null && (
          <View style={styles.cardRow}>
            <Text style={styles.cardRowLabel}>Grace</Text>
            <Text style={styles.cardRowValue}>{formatCountdown(item.secondsToDeadline)}</Text>
          </View>
        )}

        {item.status === 'claimable' && (
          <TouchableOpacity
            style={[styles.claimBtn, isClaiming && styles.claimBtnDisabled]}
            onPress={() => onClaim(item)}
            disabled={isClaiming || !!claimingOwner}
          >
            {isClaiming ? (
              <>
                <ActivityIndicator size="small" color={COLORS.bg} />
                <Text style={styles.claimBtnText}>{progress || 'Distributing…'}</Text>
              </>
            ) : (
              <Text style={styles.claimBtnText}>Distribute Estate</Text>
            )}
          </TouchableOpacity>
        )}
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Text style={styles.title}>Inheritances</Text>
        <Text style={styles.subtitle}>Vaults where you are a beneficiary</Text>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.accent} />
        }
      >
        {/* Manual import */}
        <View style={styles.importCard}>
          <Text style={styles.importLabel}>Add by owner address</Text>
          <View style={styles.importRow}>
            <TextInput
              style={styles.importInput}
              placeholder="Owner wallet address"
              placeholderTextColor={COLORS.textDim}
              value={importText}
              onChangeText={setImportText}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TouchableOpacity
              style={[styles.importBtn, (!importText || importing) && styles.importBtnDisabled]}
              onPress={onImport}
              disabled={!importText || importing}
            >
              {importing ? (
                <ActivityIndicator size="small" color={COLORS.accent} />
              ) : (
                <MaterialCommunityIcons name="plus" size={20} color={COLORS.accent} />
              )}
            </TouchableOpacity>
          </View>
        </View>

        {loading && items.length === 0 ? (
          <View style={styles.empty}>
            <ActivityIndicator size="large" color={COLORS.accent} />
          </View>
        ) : items.length === 0 ? (
          <View style={styles.empty}>
            <MaterialCommunityIcons name="inbox-outline" size={40} color={COLORS.textDim} />
            <Text style={styles.emptyText}>No inheritances found for this wallet.</Text>
            <Text style={styles.emptySub}>
              If someone named you as a beneficiary, add their owner address above.
            </Text>
          </View>
        ) : (
          items.map(renderCard)
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  header: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 12 },
  title: { fontFamily: FONTS.primaryBold, fontSize: 26, color: '#FFFFFF' },
  subtitle: { fontFamily: FONTS.primary, fontSize: 13, color: 'rgba(255,255,255,0.4)', marginTop: 2 },
  scroll: { paddingHorizontal: 20, paddingBottom: 40 },
  importCard: {
    backgroundColor: COLORS.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 14,
    marginBottom: 16,
  },
  importLabel: { fontFamily: FONTS.primaryMedium, fontSize: 12, color: 'rgba(255,255,255,0.5)', marginBottom: 8 },
  importRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  importInput: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#FFFFFF',
    fontFamily: FONTS.primary,
    fontSize: 13,
  },
  importBtn: {
    width: 44,
    height: 42,
    borderRadius: 10,
    backgroundColor: 'rgba(0,255,163,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(0,255,163,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  importBtnDisabled: { opacity: 0.4 },
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 16,
    marginBottom: 12,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 12 },
  cardLabel: { fontFamily: FONTS.primaryMedium, fontSize: 10, color: 'rgba(255,255,255,0.35)', letterSpacing: 1 },
  cardOwner: { fontFamily: FONTS.primarySemiBold, fontSize: 16, color: '#FFFFFF', marginTop: 2 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  pillDot: { width: 6, height: 6, borderRadius: 3 },
  pillText: { fontFamily: FONTS.primaryMedium, fontSize: 11 },
  cardRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  cardRowLabel: { fontFamily: FONTS.primary, fontSize: 13, color: 'rgba(255,255,255,0.5)' },
  cardRowValue: { fontFamily: FONTS.primarySemiBold, fontSize: 14, color: '#FFFFFF' },
  claimBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: COLORS.accent,
    borderRadius: 12,
    paddingVertical: 13,
    marginTop: 12,
  },
  claimBtnDisabled: { opacity: 0.7 },
  claimBtnText: { fontFamily: FONTS.primaryBold, fontSize: 14, color: COLORS.bg },
  empty: { alignItems: 'center', justifyContent: 'center', paddingVertical: 48, gap: 10 },
  emptyText: { fontFamily: FONTS.primaryMedium, fontSize: 14, color: 'rgba(255,255,255,0.5)', textAlign: 'center' },
  emptySub: { fontFamily: FONTS.primary, fontSize: 12, color: COLORS.textDim, textAlign: 'center', paddingHorizontal: 24 },
});
