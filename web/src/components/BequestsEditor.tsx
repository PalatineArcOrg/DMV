import { useEffect, useMemo, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import { COLORS } from '../lib/theme';
import { VaultView } from '../hooks/useVault';
import { useOwnerActions } from '../hooks/useOwnerActions';
import { VaultTransactionService, AssetAssignment } from '../lib/core';
import { Overlay, Blocked, inp, ghost, accent, xBtn } from './BeneficiaryEditor';

interface Row {
  assetKey: string; // 'SOL' or a mint
  amount: string;
  benIndex: number;
}
interface AssetOpt {
  key: string;
  label: string;
  decimals: number;
  isNft: boolean;
  max: number;
}

const short = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;

export function BequestsEditor({
  vault,
  actions,
  svc,
  onClose,
}: {
  vault: VaultView;
  actions: ReturnType<typeof useOwnerActions>;
  svc: VaultTransactionService;
  onClose: () => void;
}) {
  const assetOpts = useMemo<AssetOpt[]>(
    () => [
      { key: 'SOL', label: `SOL (vault ${(vault.solLamports / 1e9).toFixed(3)})`, decimals: 9, isNft: false, max: vault.solLamports / 1e9 },
      ...vault.tokens.map((t) => ({
        key: t.mint,
        label: `${t.name || t.symbol || short(t.mint)}${t.isNft ? ' — NFT' : ` (${t.uiAmount})`}`,
        decimals: t.decimals,
        isNft: t.isNft,
        max: t.uiAmount,
      })),
    ],
    [vault],
  );
  const optByKey = useMemo(() => new Map(assetOpts.map((o) => [o.key, o])), [assetOpts]);

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const busy = !!actions.state.busy;

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const plan = await svc.fetchAssetPlan(new PublicKey(vault.owner));
        if (!live) return;
        if (plan?.assignments.length) {
          setRows(
            plan.assignments.map((a) => {
              const isSol = a.mint.equals(PublicKey.default);
              if (isSol) return { assetKey: 'SOL', amount: String(a.amount.toNumber() / 1e9), benIndex: a.beneficiaryIndex };
              const mintStr = a.mint.toBase58();
              const dec = vault.tokens.find((t) => t.mint === mintStr)?.decimals ?? 0;
              const ui = a.isNft ? 1 : Number(a.amount.toString()) / 10 ** dec;
              return { assetKey: mintStr, amount: String(ui), benIndex: a.beneficiaryIndex };
            }),
          );
        }
      } catch {
        /* start empty */
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [svc, vault]);

  function set(i: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }
  function add() {
    setRows((rs) => [...rs, { assetKey: assetOpts[0]?.key ?? 'SOL', amount: '', benIndex: 0 }]);
  }
  function remove(i: number) {
    setRows((rs) => rs.filter((_, j) => j !== i));
  }

  async function save() {
    setErr(null);
    if (rows.length === 0) return setErr('Add at least one bequest, or use “Clear bequests” to remove the plan.');
    const nftMints = new Set<string>();
    const assignments: AssetAssignment[] = [];
    for (const r of rows) {
      const opt = optByKey.get(r.assetKey);
      if (!opt) return setErr('Pick an asset for every bequest.');
      if (r.benIndex < 0 || r.benIndex >= vault.beneficiaries.length) return setErr('Pick a beneficiary for every bequest.');
      if (opt.key === 'SOL') {
        const lamports = Math.round((parseFloat(r.amount) || 0) * 1e9);
        if (lamports <= 0) return setErr('SOL bequest amount must be above 0.');
        assignments.push({ mint: PublicKey.default, amount: new BN(lamports), beneficiaryIndex: r.benIndex, isNft: false });
      } else if (opt.isNft) {
        if (nftMints.has(opt.key)) return setErr('Each NFT can only be bequeathed once.');
        nftMints.add(opt.key);
        assignments.push({ mint: new PublicKey(opt.key), amount: new BN(1), beneficiaryIndex: r.benIndex, isNft: true });
      } else {
        const raw = BigInt(Math.round((parseFloat(r.amount) || 0) * 10 ** opt.decimals));
        if (raw <= 0n) return setErr('Token bequest amount must be above 0.');
        assignments.push({ mint: new PublicKey(opt.key), amount: new BN(raw.toString()), beneficiaryIndex: r.benIndex, isNft: false });
      }
    }
    const ok = await actions.saveBequests(assignments, vault.hasAssetPlan);
    if (ok) onClose();
  }

  return (
    <Overlay onClose={onClose}>
      <h2 style={{ fontSize: 17, fontWeight: 700, margin: '0 0 4px' }}>Edit bequests</h2>

      {!vault.isMutable ? (
        <Blocked text="This vault is immutable — bequests can't be changed." onClose={onClose} />
      ) : vault.beneficiaries.length === 0 ? (
        <Blocked text="Add beneficiaries first — bequests assign specific assets to them." onClose={onClose} />
      ) : (
        <>
          <p style={{ color: COLORS.textDim, fontSize: 12.5, margin: '0 0 16px', lineHeight: 1.5 }}>
            Leave specific assets to specific people. These are carved out first; everything else splits by the
            beneficiary shares. You can only bequeath what the vault holds.
          </p>

          {loading ? (
            <p style={{ color: COLORS.textDim, fontSize: 13 }}>Loading current plan…</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 320, overflowY: 'auto' }}>
              {rows.map((r, i) => {
                const opt = optByKey.get(r.assetKey);
                return (
                  <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <select value={r.assetKey} onChange={(e) => set(i, { assetKey: e.target.value })} style={{ ...inp, flex: 1.4, minWidth: 0 }}>
                      {assetOpts.map((o) => (
                        <option key={o.key} value={o.key}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    <input
                      value={opt?.isNft ? '1' : r.amount}
                      onChange={(e) => set(i, { amount: e.target.value })}
                      disabled={opt?.isNft}
                      inputMode="decimal"
                      placeholder="Amount"
                      style={{ ...inp, width: 84, opacity: opt?.isNft ? 0.6 : 1 }}
                    />
                    <select value={r.benIndex} onChange={(e) => set(i, { benIndex: Number(e.target.value) })} style={{ ...inp, flex: 1, minWidth: 0 }}>
                      {vault.beneficiaries.map((b, bi) => (
                        <option key={bi} value={bi}>
                          {short(b.wallet)} ({(b.shareBps / 100).toFixed(0)}%)
                        </option>
                      ))}
                    </select>
                    <button onClick={() => remove(i)} style={xBtn} title="Remove">
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <div style={{ margin: '12px 0' }}>
            <button onClick={add} style={ghost}>
              + Add bequest
            </button>
          </div>

          {err && <p style={{ color: COLORS.critical, fontSize: 12.5, margin: '0 0 10px' }}>{err}</p>}
          {actions.state.error && <p style={{ color: COLORS.critical, fontSize: 12.5, margin: '0 0 10px' }}>{actions.state.error}</p>}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
            {vault.hasAssetPlan ? (
              <button
                onClick={async () => {
                  const ok = await actions.clearBequests();
                  if (ok) onClose();
                }}
                disabled={busy}
                style={{ ...ghost, color: COLORS.critical, borderColor: COLORS.critical }}
              >
                Clear all
              </button>
            ) : (
              <span />
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={onClose} style={ghost}>
                Cancel
              </button>
              <button onClick={save} disabled={busy} style={accent(!busy)}>
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </>
      )}
    </Overlay>
  );
}
