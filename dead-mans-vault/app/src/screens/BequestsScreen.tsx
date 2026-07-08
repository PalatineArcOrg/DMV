import React, { useMemo, useState, useCallback, useRef } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
  View,
  Text,
  Image,
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
import { PortfolioScanner } from '../services/PortfolioScanner';
import { getRpcUrl, getHeliusApiKey } from '../utils/rpcConfig';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { PickerModal, PickerOption } from '../components/PickerModal';
import type { AssetAssignment } from '../types/vault';

// Single set/update_asset_plan tx must fit the 1232-byte limit. Distinct bequest
// mints ride in the account-keys array (~33B each, passed for on-chain mint
// validation); assignments are ~42B of ix data. So an all-NFT plan (every mint
// distinct) caps lower (~11) than an all-SOL one (~21). Mirror of
// VaultTransactionService.assertPlanFits. SOL-sentinel bequests use no mint account.
const SOL_SENTINEL = PublicKey.default.toBase58();
const planFits = (list: { mint: string }[]): boolean => {
  const distinct = new Set(list.map((d) => d.mint).filter((m) => m !== SOL_SENTINEL)).size;
  return 335 + 33 * distinct + 42 * list.length <= 1180;
};

interface DraftAssignment {
  mint: string;
  symbol: string;
  decimals: number;
  isNft: boolean;
  uiAmount: string;
  beneficiaryIndex: number;
  holding: number;
  image?: string; // NFT thumbnail (resolved from metadata) so the picker isn't just an address
}

// An asset actually held by the vault (what a bequest can carve out).
interface VaultAsset {
  mint: PublicKey;
  symbol: string;
  decimals: number;
  amount: number; // ui amount held by the vault (distributable SOL, or token balance)
  image?: string; // NFT thumbnail (resolved from metadata)
  risk?: string | null; // A1: issuer could make this mint un-distributable later (warn)
}

export function BequestsScreen() {
  const { publicKey, signTransaction } = useWallet();
  const vaultConfig = useVaultStore((s) => s.vaultConfig);
  const localBeneficiaries = useVaultStore((s) => s.beneficiaries);
  const balances = usePortfolioStore((s) => s.balances);

  const [drafts, setDrafts] = useState<DraftAssignment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [vaultAssets, setVaultAssets] = useState<VaultAsset[]>([]);
  const [assetsError, setAssetsError] = useState(false);
  const [assetPickerFor, setAssetPickerFor] = useState<number | null>(null);
  const [benefPickerFor, setBenefPickerFor] = useState<number | null>(null);

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
    const txService = new VaultTransactionService();
    const conn = txService.getConnection();
    const [vaultPda] = txService.getVaultPDA(publicKey);

    // Load the vault's raw holdings — this is the SOURCE OF TRUTH for what's
    // bequeathable. Retry a few times; a transient failure here must NOT be shown as
    // "only SOL" (which silently hides the vault's real tokens/NFTs).
    let solAmount = 0;
    let tokens: { mint: PublicKey; amount: bigint; decimals: number; uiAmount: number }[] | null = null;
    for (let tryN = 0; tryN < 3 && tokens === null; tryN++) {
      try {
        const info = await conn.getAccountInfo(vaultPda);
        const rent = info ? await conn.getMinimumBalanceForRentExemption(info.data.length) : 0;
        // Distributable SOL = vault balance − rent − reserved keeper bounty.
        solAmount = info ? Math.max(0, (info.lamports - rent - KEEPER_BOUNTY_LAMPORTS) / 1e9) : 0;
        tokens = await txService.getVaultTokenBalances(vaultPda);
      } catch {
        if (tryN < 2) await new Promise((r) => setTimeout(r, 400 * (tryN + 1)));
      }
    }
    if (tokens === null) {
      // Could not read the vault's holdings — surface the error instead of hiding the tokens.
      setVaultAssets(solOnly);
      setAssetsError(true);
      return solOnly;
    }

    // Metadata is best-effort and NEVER fatal.
    let meta = new Map<string, { name: string; symbol: string; image: string | null }>();
    try {
      const scanner = new PortfolioScanner(getRpcUrl(), getHeliusApiKey());
      meta = await scanner.resolveNftMetadata(tokens.map((t) => t.mint));
    } catch {
      // symbol-only below
    }

    // Enrich each token INDEPENDENTLY: a throw resolving one token's symbol/risk
    // (e.g. a Hermes named-export issue for a Token-2022 stock) must never drop the
    // whole list — every held token/NFT stays bequeathable, with a fallback label.
    const tokenAssets: VaultAsset[] = [];
    for (const t of tokens) {
      let symbol = `${t.mint.toBase58().slice(0, 4)}…`;
      let image: string | undefined;
      let risk: string | null = null;
      try {
        const m = meta.get(t.mint.toBase58());
        const sMeta = PortfolioScanner.stockMeta(t.mint.toBase58());
        const known = balances.find((b: any) => b.mint?.toBase58?.() === t.mint.toBase58());
        symbol = sMeta?.symbol || m?.name || m?.symbol || known?.symbol || symbol;
        image = m?.image ?? (known as any)?.image ?? undefined;
        risk = await txService.checkBequestRisk(t.mint).catch(() => null);
      } catch {
        // keep fallback symbol — the token still appears and is bequeathable
      }
      tokenAssets.push({ mint: t.mint, symbol, decimals: t.decimals, amount: t.uiAmount, image, risk });
    }

    const result: VaultAsset[] = [{ mint: PublicKey.default, symbol: 'SOL', decimals: 9, amount: solAmount }, ...tokenAssets];
    setVaultAssets(result);
    setAssetsError(false);
    return result;
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
    if (assets.length === 0 || beneficiaries.length === 0) {
      Alert.alert('Nothing to assign', 'You need at least one held token/NFT and one beneficiary.');
      return;
    }
    const first = assets[0];
    const next = {
      mint: first.mint.toBase58(),
      symbol: first.symbol,
      decimals: first.decimals,
      isNft: first.decimals === 0 && first.amount === 1,
      uiAmount: first.decimals === 0 && first.amount === 1 ? '1' : '',
      beneficiaryIndex: beneficiaries[0].index,
      holding: first.amount,
      image: first.image,
    };
    if (!planFits([...drafts, next])) {
      Alert.alert('Plan full', 'This bequest plan is as large as a single transaction allows. Remove a bequest, or use fewer distinct tokens.');
      return;
    }
    setDrafts((d) => [...d, next]);
  };

  const updateDraft = (i: number, patch: Partial<DraftAssignment>) => {
    setDrafts((d) => d.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  };

  const removeDraft = (i: number) => setDrafts((d) => d.filter((_, idx) => idx !== i));

  const selectAsset = (i: number, mintKey: string) => {
    const a = assets.find((x) => x.mint.toBase58() === mintKey);
    if (!a) return;
    const nft = a.decimals === 0 && a.amount === 1;
    updateDraft(i, {
      mint: a.mint.toBase58(),
      symbol: a.symbol,
      decimals: a.decimals,
      isNft: nft,
      uiAmount: nft ? '1' : '',
      holding: a.amount,
      image: a.image,
    });
  };

  const selectBeneficiary = (i: number, indexKey: string) => {
    updateDraft(i, { beneficiaryIndex: Number(indexKey) });
  };

  const fmtHeld = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/\.?0+$/, ''));

  // Options for the selection modals, derived from the (already-loaded) vault assets
  // and on-chain beneficiaries. SOL is always the first asset option.
  const assetOptions: PickerOption[] = useMemo(
    () => assets.map((a) => ({
      key: a.mint.toBase58(),
      label: a.symbol || `${a.mint.toBase58().slice(0, 6)}…`,
      sublabel: fmtHeld(a.amount),
      badge: a.decimals === 0 && a.amount === 1 ? 'NFT' : undefined,
      image: a.image,
      warn: !!a.risk,
    })),
    [assets],
  );
  const benefOptions: PickerOption[] = useMemo(
    () => beneficiaries.map((b) => ({
      key: String(b.index),
      label: b.label,
      sublabel: `${(b.shareBps / 100).toFixed(0)}%`,
    })),
    [beneficiaries],
  );

  const validate = (): string | null => {
    if (drafts.length === 0) return 'Add at least one bequest.';
    if (!planFits(drafts)) return 'Too many bequests to fit one transaction — remove one, or use fewer distinct tokens.';
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

  const riskWarnings = useMemo(() => {
    // A1 mitigation #3: warn for any assigned mint the issuer could later make
    // un-distributable (freeze/pause/seize/hook). Deduped per mint; non-blocking.
    const riskByMint = new Map<string, string>();
    for (const a of vaultAssets) if (a.risk) riskByMint.set(a.mint.toBase58(), a.risk);
    const seen = new Set<string>();
    const warnings: string[] = [];
    for (const d of drafts) {
      const r = riskByMint.get(d.mint);
      if (r && !seen.has(d.mint)) {
        seen.add(d.mint);
        warnings.push(`${d.symbol}: ${r}`);
      }
    }
    return warnings;
  }, [drafts, vaultAssets]);

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

  // Clear the whole AssetPlan (owner-signed, pre-grace). Removes every specific
  // bequest so the owner can edit their beneficiary set — which update_vault locks
  // while a plan exists — then re-add bequests. Assets stay in the vault and split
  // pro-rata by share until a new plan is set.
  const onClearPlan = () => {
    if (!publicKey) return;
    Alert.alert(
      'Clear all bequests?',
      'This removes every specific bequest so you can edit your beneficiaries. Your assets stay in the vault and will distribute pro-rata by share until you set new bequests.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear bequests',
          style: 'destructive',
          onPress: async () => {
            setSubmitting(true);
            try {
              const txService = new VaultTransactionService();
              const connection = txService.getConnection();
              const tx = await txService.buildClearAssetPlanTx(publicKey);
              tx.feePayer = publicKey;
              const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
              tx.recentBlockhash = blockhash;
              const signed = await signTransaction(tx);
              const sig = await connection.sendRawTransaction(signed.serialize(), {
                skipPreflight: false,
                preflightCommitment: 'confirmed',
              });
              await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');

              const fresh = await txService.fetchVaultConfig(publicKey);
              if (fresh) useVaultStore.getState().setVaultConfig(fresh);
              await loadPlan(await loadVaultAssets());

              Alert.alert('Bequests cleared', 'All specific bequests were removed. You can now edit your beneficiaries, then set new bequests.');
            } catch (e: any) {
              Alert.alert('Could not clear bequests', e?.message ?? 'Transaction failed.');
            } finally {
              setSubmitting(false);
            }
          },
        },
      ],
    );
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

        {assetsError && (
          <TouchableOpacity style={styles.assetsErrorBanner} onPress={() => loadVaultAssets()}>
            <Text style={styles.assetsErrorText}>
              Couldn't load your vault's tokens — your RPC may be unreachable. Tap to retry, or
              switch RPC in Settings → Network. (SOL is still available below.)
            </Text>
          </TouchableOpacity>
        )}

        {drafts.map((d, i) => {
          const benef = beneficiaries.find((b) => b.index === d.beneficiaryIndex);
          return (
            <View key={i} style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.cardLabel}>Asset</Text>
                <TouchableOpacity style={styles.pill} onPress={() => setAssetPickerFor(i)}>
                  {d.image ? <Image source={{ uri: d.image }} style={styles.pillThumb} /> : null}
                  <Text style={styles.pillText}>
                    {d.symbol || `${d.mint.slice(0, 6)}…`}{d.isNft ? ' · NFT' : ''}
                  </Text>
                  <MaterialCommunityIcons name="chevron-down" size={16} color="rgba(255,255,255,0.4)" style={styles.pillCaret} />
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
                <TouchableOpacity style={styles.pill} onPress={() => setBenefPickerFor(i)}>
                  <Text style={styles.pillText}>
                    {benef ? `${benef.label} (${(benef.shareBps / 100).toFixed(0)}%)` : '—'}
                  </Text>
                  <MaterialCommunityIcons name="chevron-down" size={16} color="rgba(255,255,255,0.4)" style={styles.pillCaret} />
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
          {drafts.length} {drafts.length === 1 ? 'bequest' : 'bequests'}
        </Text>

        {overAllocatedWarnings.map((w, i) => (
          <Text key={`o${i}`} style={styles.warning}>⚠ {w}</Text>
        ))}
        {riskWarnings.map((w, i) => (
          <Text key={`r${i}`} style={styles.warning}>⚠ {w}</Text>
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

      {hasAssetPlan && (
        <TouchableOpacity
          style={[styles.clearBtn, submitting && styles.saveBtnDisabled]}
          onPress={onClearPlan}
          disabled={submitting}
        >
          <Text style={styles.clearBtnText}>Clear all bequests</Text>
        </TouchableOpacity>
      )}

      <PickerModal
        visible={assetPickerFor !== null}
        title="Choose an asset"
        options={assetOptions}
        selectedKey={assetPickerFor !== null ? drafts[assetPickerFor]?.mint ?? '' : ''}
        onSelect={(k) => { if (assetPickerFor !== null) selectAsset(assetPickerFor, k); }}
        onClose={() => setAssetPickerFor(null)}
      />
      <PickerModal
        visible={benefPickerFor !== null}
        title="Choose a beneficiary"
        options={benefOptions}
        selectedKey={benefPickerFor !== null ? String(drafts[benefPickerFor]?.beneficiaryIndex ?? '') : ''}
        onSelect={(k) => { if (benefPickerFor !== null) selectBeneficiary(benefPickerFor, k); }}
        onClose={() => setBenefPickerFor(null)}
      />
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
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,255,163,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(0,255,163,0.25)',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  pillText: { color: COLORS.accent, fontSize: 13, fontFamily: FONTS.primaryMedium },
  pillThumb: { width: 20, height: 20, borderRadius: 5, marginRight: 8, backgroundColor: 'rgba(255,255,255,0.06)' },
  pillCaret: { marginLeft: 6 },
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
  assetsErrorBanner: { backgroundColor: 'rgba(239,68,68,0.12)', borderColor: COLORS.critical, borderWidth: 1, borderRadius: 10, padding: 12, marginBottom: 14 },
  assetsErrorText: { color: COLORS.critical, fontSize: 12.5, fontFamily: FONTS.primary, lineHeight: 18 },
  saveBtn: {
    backgroundColor: COLORS.accent,
    margin: 20,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  saveBtnDisabled: { opacity: 0.4 },
  saveBtnText: { color: COLORS.bg, fontSize: 15, fontFamily: FONTS.primaryMedium },
  clearBtn: {
    marginHorizontal: 20,
    marginBottom: 20,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.critical,
  },
  clearBtnText: { color: COLORS.critical, fontSize: 14, fontFamily: FONTS.primaryMedium },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 },
  emptyTitle: { color: '#FFFFFF', fontSize: 18, fontFamily: FONTS.primaryMedium, marginBottom: 10 },
  emptyText: { color: 'rgba(255,255,255,0.6)', fontSize: 14, fontFamily: FONTS.primary, textAlign: 'center', lineHeight: 20 },
});
