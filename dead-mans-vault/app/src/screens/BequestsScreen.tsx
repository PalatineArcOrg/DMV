import React, { useMemo, useState, useCallback, useRef } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { PublicKey } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import { COLORS, FONTS, KEEPER_BOUNTY_LAMPORTS } from '../utils/constants';
import { useWallet } from '../hooks/useWallet';
import { useVaultStore } from '../store/useVaultStore';
import { usePortfolioStore } from '../store/usePortfolioStore';
import { VaultTransactionService } from '../services/VaultTransactionService';
import type { AssetAssignment } from '../types/vault';

const MAX_ASSIGNMENTS_PER_TX = 18; // single-tx cap (1232-byte limit; 64 is storage)

interface DraftAssignment {
  mint: string;
  symbol: string;
  decimals: number;
  isNft: boolean;
  uiAmount: string;
  beneficiaryIndex: number;
  holding: number;
}

// An asset actually held by the vault (what a bequest can carve out).
interface VaultAsset {
  mint: PublicKey;
  symbol: string;
  decimals: number;
  amount: number; // ui amount held by the vault (distributable SOL, or token balance)
}

export function BequestsScreen() {
  const { publicKey, signTransaction } = useWallet();
  const vaultConfig = useVaultStore((s) => s.vaultConfig);
  const localBeneficiaries = useVaultStore((s) => s.beneficiaries);
  const balances = usePortfolioStore((s) => s.balances);

  const [drafts, setDrafts] = useState<DraftAssignment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [vaultAssets, setVaultAssets] = useState<VaultAsset[]>([]);

  // On-chain beneficiary order is authoritative for assignment indices.
  const beneficiaries = useMemo(() => {
    const onChain = vaultConfig?.beneficiaries ?? [];
    return onChain.map((b: any, i: number) => {
      const wallet = new PublicKey(b.wallet);
      const local = localBeneficiaries.find((lb) => lb.wallet.toBase58() === wallet.toBase58());
      return {
        index: i,
        wallet,
        shareBps: b.shareBps as number,
        label: local?.label || `${wallet.toBase58().slice(0, 4)}…${wallet.toBase58().slice(-4)}`,
      };
    });
  }, [vaultConfig, localBeneficiaries]);

  // Bequeathable assets come from the VAULT (what actually gets distributed), NOT
  // the owner's wallet — a bequest for an asset the vault doesn't hold would pay 0
  // and (previously) stall execution. `balances` (wallet portfolio) is used only to
  // resolve friendly token symbols.
  const loadVaultAssets = useCallback(async (): Promise<VaultAsset[]> => {
    if (!publicKey) return [];
    const solOnly: VaultAsset[] = [{ mint: PublicKey.default, symbol: 'SOL', decimals: 9, amount: 0 }];
    try {
      const txService = new VaultTransactionService();
      const conn = txService.getConnection();
      const [vaultPda] = txService.getVaultPDA(publicKey);
      const info = await conn.getAccountInfo(vaultPda);
      const rent = info ? await conn.getMinimumBalanceForRentExemption(info.data.length) : 0;
      // Distributable SOL = vault balance − rent − reserved keeper bounty.
      const solAmount = info ? Math.max(0, (info.lamports - rent - KEEPER_BOUNTY_LAMPORTS) / 1e9) : 0;
      const tokens = await txService.getVaultTokenBalances(vaultPda);
      const tokenAssets: VaultAsset[] = tokens.map((t) => {
        const known = balances.find((b: any) => b.mint?.toBase58?.() === t.mint.toBase58());
        return {
          mint: t.mint,
          symbol: known?.symbol ?? `${t.mint.toBase58().slice(0, 4)}…`,
          decimals: t.decimals,
          amount: t.uiAmount,
        };
      });
      const result: VaultAsset[] = [{ mint: PublicKey.default, symbol: 'SOL', decimals: 9, amount: solAmount }, ...tokenAssets];
      setVaultAssets(result);
      return result;
    } catch {
      setVaultAssets(solOnly);
      return solOnly;
    }
  }, [publicKey, balances]);

  const assets = useMemo(
    () => (vaultAssets.length > 0 ? vaultAssets : [{ mint: PublicKey.default, symbol: 'SOL', decimals: 9, amount: 0 } as VaultAsset]),
    [vaultAssets],
  );

  const hasAssetPlan = !!vaultConfig?.hasAssetPlan;
  const isActiveVault = !!vaultConfig && vaultConfig.active && !vaultConfig.executed;

  // Load the existing on-chain AssetPlan into the draft list so already-saved
  // bequests are shown (and editable). Reads live from chain (`fetchAssetPlan`)
  // rather than relying on the possibly-stale store flag.
  const loadPlan = useCallback(async (va: VaultAsset[]) => {
    if (!publicKey) return;
    try {
      const txService = new VaultTransactionService();
      const plan = await txService.fetchAssetPlan(publicKey);
      if (!plan || plan.assignments.length === 0) return;
      const existing: DraftAssignment[] = plan.assignments.map((a) => {
        const raw = BN.isBN(a.amount) ? (a.amount as BN) : new BN(a.amount as any);
        if (a.mint.equals(PublicKey.default)) {
          return {
            mint: PublicKey.default.toBase58(),
            symbol: 'SOL',
            decimals: 9,
            isNft: false,
            uiAmount: (raw.toNumber() / Math.pow(10, 9)).toString(),
            beneficiaryIndex: a.beneficiaryIndex,
            holding: va.find((x) => x.mint.equals(PublicKey.default))?.amount ?? 0,
          };
        }
        const held = va.find((x) => x.mint.equals(a.mint));
        const decimals = held?.decimals ?? 0;
        return {
          mint: a.mint.toBase58(),
          symbol: held?.symbol ?? `${a.mint.toBase58().slice(0, 4)}…`,
          decimals,
          isNft: a.isNft,
          uiAmount: a.isNft ? '1' : (raw.toNumber() / Math.pow(10, decimals)).toString(),
          beneficiaryIndex: a.beneficiaryIndex,
          holding: held?.amount ?? 0,
        };
      });
      setDrafts(existing);
    } catch {
      // leave drafts as-is on failure — the user can still add bequests
    }
  }, [publicKey]);

  // React Navigation keeps this screen mounted, so a one-time mount effect never
  // re-runs on return. On every focus, refresh the vault's assets, then reload the
  // saved plan — but only when the draft list is empty, so unsaved edits aren't lost.
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  useFocusEffect(
    useCallback(() => {
      (async () => {
        const va = await loadVaultAssets();
        if (draftsRef.current.length === 0) await loadPlan(va);
      })();
    }, [loadVaultAssets, loadPlan]),
  );

  const addDraft = () => {
    if (drafts.length >= MAX_ASSIGNMENTS_PER_TX) {
      Alert.alert('Limit reached', `A vault can hold up to ${MAX_ASSIGNMENTS_PER_TX} specific bequests in a single update.`);
      return;
    }
    if (assets.length === 0 || beneficiaries.length === 0) {
      Alert.alert('Nothing to assign', 'You need at least one held token/NFT and one beneficiary.');
      return;
    }
    const first = assets[0];
    setDrafts((d) => [
      ...d,
      {
        mint: first.mint.toBase58(),
        symbol: first.symbol,
        decimals: first.decimals,
        isNft: first.decimals === 0 && first.amount === 1,
        uiAmount: first.decimals === 0 && first.amount === 1 ? '1' : '',
        beneficiaryIndex: beneficiaries[0].index,
        holding: first.amount,
      },
    ]);
  };

  const updateDraft = (i: number, patch: Partial<DraftAssignment>) => {
    setDrafts((d) => d.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  };

  const removeDraft = (i: number) => setDrafts((d) => d.filter((_, idx) => idx !== i));

  const cycleAsset = (i: number) => {
    const cur = drafts[i];
    const pos = assets.findIndex((a) => a.mint.toBase58() === cur.mint);
    const next = assets[(pos + 1) % assets.length];
    const nft = next.decimals === 0 && next.amount === 1;
    updateDraft(i, {
      mint: next.mint.toBase58(),
      symbol: next.symbol,
      decimals: next.decimals,
      isNft: nft,
      uiAmount: nft ? '1' : '',
      holding: next.amount,
    });
  };

  const cycleBeneficiary = (i: number) => {
    const cur = drafts[i];
    const pos = beneficiaries.findIndex((b) => b.index === cur.beneficiaryIndex);
    const next = beneficiaries[(pos + 1) % beneficiaries.length];
    updateDraft(i, { beneficiaryIndex: next.index });
  };

  const validate = (): string | null => {
    if (drafts.length === 0) return 'Add at least one bequest.';
    if (drafts.length > MAX_ASSIGNMENTS_PER_TX) return `Max ${MAX_ASSIGNMENTS_PER_TX} bequests per update.`;
    const nftMints = new Set<string>();
    for (const d of drafts) {
      if (d.isNft) {
        if (nftMints.has(d.mint)) return `An NFT (${d.symbol}) can only be assigned once.`;
        nftMints.add(d.mint);
      } else {
        const amt = Number(d.uiAmount);
        if (!Number.isFinite(amt) || amt <= 0) return `Enter a valid amount for ${d.symbol}.`;
      }
    }
    return null;
  };

  const overAllocatedWarnings = useMemo(() => {
    // Non-blocking: warn if total assigned of a mint exceeds the current holding.
    const byMint = new Map<string, { total: number; holding: number; symbol: string }>();
    for (const d of drafts) {
      const amt = d.isNft ? 1 : Number(d.uiAmount) || 0;
      const cur = byMint.get(d.mint) ?? { total: 0, holding: d.holding, symbol: d.symbol };
      cur.total += amt;
      byMint.set(d.mint, cur);
    }
    const warnings: string[] = [];
    byMint.forEach((v) => {
      if (v.total > v.holding) {
        warnings.push(`${v.symbol}: assigning ${v.total} but you hold ${v.holding} (paid in order; later bequests may underfill).`);
      }
    });
    return warnings;
  }, [drafts]);

  const onSave = async () => {
    if (!publicKey) return;
    const err = validate();
    if (err) {
      Alert.alert('Check your bequests', err);
      return;
    }

    const assignments: AssetAssignment[] = drafts.map((d) => {
      const raw = d.isNft
        ? new BN(1)
        : new BN(Math.round(Number(d.uiAmount) * Math.pow(10, d.decimals)));
      return {
        mint: new PublicKey(d.mint),
        amount: raw,
        beneficiaryIndex: d.beneficiaryIndex,
        isNft: d.isNft,
      };
    });

    setSubmitting(true);
    try {
      const txService = new VaultTransactionService();
      const connection = txService.getConnection();
      const tx = hasAssetPlan
        ? await txService.buildUpdateAssetPlanTx(publicKey, assignments)
        : await txService.buildSetAssetPlanTx(publicKey, assignments);

      tx.feePayer = publicKey;
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      const signed = await signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');

      // Refresh on-chain config so hasAssetPlan reflects immediately.
      const fresh = await txService.fetchVaultConfig(publicKey);
      if (fresh) useVaultStore.getState().setVaultConfig(fresh);

      Alert.alert('Bequests saved', 'Your specific bequests are now recorded on-chain.');
      // Re-load the canonical saved plan so the list keeps showing the bequests
      // (instead of going blank) right after saving.
      await loadPlan(await loadVaultAssets());
    } catch (e: any) {
      Alert.alert('Could not save bequests', e?.message ?? 'Transaction failed.');
    } finally {
      setSubmitting(false);
    }
  };

  if (!isActiveVault) {
    return (
      <SafeAreaView style={styles.container} edges={['bottom']}>
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No active vault</Text>
          <Text style={styles.emptyText}>
            Activate your vault first. Specific bequests are recorded on-chain after the vault exists.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.intro}>
          Carve out exact tokens or whole NFTs to specific beneficiaries. Carved bequests are paid first;
          everything else splits pro-rata by share. SOL is always pro-rata.
        </Text>

        {drafts.map((d, i) => {
          const benef = beneficiaries.find((b) => b.index === d.beneficiaryIndex);
          return (
            <View key={i} style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.cardLabel}>Asset</Text>
                <TouchableOpacity style={styles.pill} onPress={() => cycleAsset(i)}>
                  <Text style={styles.pillText}>
                    {d.symbol || `${d.mint.slice(0, 6)}…`}{d.isNft ? ' · NFT' : ''}
                  </Text>
                </TouchableOpacity>
              </View>

              {!d.isNft && (
                <View style={styles.row}>
                  <Text style={styles.cardLabel}>Amount</Text>
                  <View style={styles.amountGroup}>
                    <TextInput
                      style={styles.input}
                      keyboardType="decimal-pad"
                      placeholder={`max ${d.holding}`}
                      placeholderTextColor="rgba(255,255,255,0.3)"
                      value={d.uiAmount}
                      onChangeText={(t) => updateDraft(i, { uiAmount: t })}
                    />
                    <TouchableOpacity
                      style={[styles.maxBtn, d.holding <= 0 && styles.maxBtnDisabled]}
                      disabled={d.holding <= 0}
                      onPress={() => updateDraft(i, { uiAmount: String(d.holding) })}
                    >
                      <Text style={styles.maxBtnText}>MAX</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}

              <View style={styles.row}>
                <Text style={styles.cardLabel}>To</Text>
                <TouchableOpacity style={styles.pill} onPress={() => cycleBeneficiary(i)}>
                  <Text style={styles.pillText}>
                    {benef ? `${benef.label} (${(benef.shareBps / 100).toFixed(0)}%)` : '—'}
                  </Text>
                </TouchableOpacity>
              </View>

              <TouchableOpacity onPress={() => removeDraft(i)}>
                <Text style={styles.remove}>Remove</Text>
              </TouchableOpacity>
            </View>
          );
        })}

        <TouchableOpacity style={styles.addBtn} onPress={addDraft}>
          <Text style={styles.addBtnText}>+ Add bequest</Text>
        </TouchableOpacity>

        <Text style={styles.counter}>
          {drafts.length} / {MAX_ASSIGNMENTS_PER_TX} bequests
        </Text>

        {overAllocatedWarnings.map((w, i) => (
          <Text key={i} style={styles.warning}>⚠ {w}</Text>
        ))}
      </ScrollView>

      <TouchableOpacity
        style={[styles.saveBtn, (submitting || drafts.length === 0) && styles.saveBtnDisabled]}
        onPress={onSave}
        disabled={submitting || drafts.length === 0}
      >
        {submitting ? (
          <ActivityIndicator color={COLORS.bg} />
        ) : (
          <Text style={styles.saveBtnText}>{hasAssetPlan ? 'Update bequests' : 'Save bequests'}</Text>
        )}
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  scroll: { padding: 20, paddingBottom: 40 },
  intro: { color: 'rgba(255,255,255,0.6)', fontSize: 13, fontFamily: FONTS.primary, lineHeight: 19, marginBottom: 20 },
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    padding: 16,
    marginBottom: 14,
  },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  cardLabel: { color: 'rgba(255,255,255,0.5)', fontSize: 13, fontFamily: FONTS.primary },
  pill: {
    backgroundColor: 'rgba(0,255,163,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(0,255,163,0.25)',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  pillText: { color: COLORS.accent, fontSize: 13, fontFamily: FONTS.primaryMedium },
  input: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: '#FFFFFF',
    fontSize: 14,
    fontFamily: FONTS.primary,
    minWidth: 96,
    textAlign: 'right',
  },
  amountGroup: { flexDirection: 'row', alignItems: 'center' },
  maxBtn: {
    marginLeft: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 10,
    backgroundColor: 'rgba(0,255,163,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(0,255,163,0.3)',
  },
  maxBtnDisabled: { opacity: 0.35 },
  maxBtnText: { color: COLORS.accent, fontSize: 12, fontFamily: FONTS.primaryMedium },
  remove: { color: COLORS.critical, fontSize: 12, fontFamily: FONTS.primary, marginTop: 4 },
  addBtn: {
    borderWidth: 1,
    borderColor: 'rgba(0,255,163,0.3)',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
  },
  addBtnText: { color: COLORS.accent, fontSize: 14, fontFamily: FONTS.primaryMedium },
  counter: { color: 'rgba(255,255,255,0.4)', fontSize: 12, fontFamily: FONTS.primary, textAlign: 'center', marginTop: 14 },
  warning: { color: COLORS.warning, fontSize: 12, fontFamily: FONTS.primary, marginTop: 10, lineHeight: 17 },
  saveBtn: {
    backgroundColor: COLORS.accent,
    margin: 20,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  saveBtnDisabled: { opacity: 0.4 },
  saveBtnText: { color: COLORS.bg, fontSize: 15, fontFamily: FONTS.primaryMedium },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 },
  emptyTitle: { color: '#FFFFFF', fontSize: 18, fontFamily: FONTS.primaryMedium, marginBottom: 10 },
  emptyText: { color: 'rgba(255,255,255,0.6)', fontSize: 14, fontFamily: FONTS.primary, textAlign: 'center', lineHeight: 20 },
});
