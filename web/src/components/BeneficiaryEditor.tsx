import { useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { COLORS } from '../lib/theme';
import { VaultView } from '../hooks/useVault';
import { useOwnerActions } from '../hooks/useOwnerActions';

interface Row {
  wallet: string;
  share: string; // percent as typed
}

export function BeneficiaryEditor({
  vault,
  owner,
  actions,
  onClose,
}: {
  vault: VaultView;
  owner: string;
  actions: ReturnType<typeof useOwnerActions>;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<Row[]>(
    vault.beneficiaries.map((b) => ({ wallet: b.wallet, share: String(b.shareBps / 100) })),
  );
  const [err, setErr] = useState<string | null>(null);
  const busy = !!actions.state.busy;

  const totalBps = rows.reduce((s, r) => s + Math.round((parseFloat(r.share) || 0) * 100), 0);

  function set(i: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }
  function add() {
    if (rows.length < 20) setRows((rs) => [...rs, { wallet: '', share: '' }]);
  }
  function remove(i: number) {
    setRows((rs) => rs.filter((_, j) => j !== i));
  }

  async function save() {
    setErr(null);
    if (rows.length < 1 || rows.length > 20) return setErr('You need between 1 and 20 beneficiaries.');
    const bens: { wallet: string; shareBps: number }[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      let pk: PublicKey;
      try {
        pk = new PublicKey(r.wallet.trim());
      } catch {
        return setErr(`Invalid wallet address: ${r.wallet.slice(0, 8)}…`);
      }
      const key = pk.toBase58();
      if (key === owner) return setErr("You can't be your own beneficiary.");
      if (seen.has(key)) return setErr('Duplicate beneficiary address.');
      seen.add(key);
      const bps = Math.round((parseFloat(r.share) || 0) * 100);
      if (bps <= 0) return setErr('Every share must be above 0%.');
      bens.push({ wallet: key, shareBps: bps });
    }
    if (totalBps !== 10000) return setErr(`Shares must add up to exactly 100% (currently ${(totalBps / 100).toFixed(2)}%).`);
    const ok = await actions.updateBeneficiaries(bens);
    if (ok) onClose();
  }

  return (
    <Overlay onClose={onClose}>
      <h2 style={{ fontSize: 17, fontWeight: 700, margin: '0 0 4px' }}>Edit beneficiaries</h2>

      {vault.hasAssetPlan ? (
        <Blocked
          text="Beneficiaries are locked while you have specific bequests (their order is referenced by your bequest plan). Clear your bequests first, then edit beneficiaries."
          actionLabel="Clear bequests"
          busy={busy}
          onAction={async () => {
            const ok = await actions.clearBequests();
            if (ok) onClose();
          }}
          onClose={onClose}
        />
      ) : !vault.isMutable ? (
        <Blocked text="This vault is immutable — beneficiaries can't be changed." onClose={onClose} />
      ) : (
        <>
          <p style={{ color: COLORS.textDim, fontSize: 12.5, margin: '0 0 16px', lineHeight: 1.5 }}>
            Set who inherits and each person's share. Shares must total 100%.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 300, overflowY: 'auto' }}>
            {rows.map((r, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  value={r.wallet}
                  onChange={(e) => set(i, { wallet: e.target.value })}
                  placeholder="Wallet address"
                  style={{ ...inp, flex: 1, fontFamily: 'monospace', fontSize: 12 }}
                />
                <input
                  value={r.share}
                  onChange={(e) => set(i, { share: e.target.value })}
                  inputMode="decimal"
                  placeholder="%"
                  style={{ ...inp, width: 64, textAlign: 'right' }}
                />
                <button onClick={() => remove(i)} style={xBtn} title="Remove">
                  ×
                </button>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '12px 0' }}>
            <button onClick={add} disabled={rows.length >= 20} style={ghost}>
              + Add beneficiary
            </button>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: totalBps === 10000 ? COLORS.accent : COLORS.warning }}>
              Total: {(totalBps / 100).toFixed(2)}%
            </span>
          </div>

          {err && <p style={{ color: COLORS.critical, fontSize: 12.5, margin: '0 0 10px' }}>{err}</p>}
          {actions.state.error && <p style={{ color: COLORS.critical, fontSize: 12.5, margin: '0 0 10px' }}>{actions.state.error}</p>}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={onClose} style={ghost}>
              Cancel
            </button>
            <button onClick={save} disabled={busy} style={accent(!busy)}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </>
      )}
    </Overlay>
  );
}

/* shared bits reused by the bequests editor too */

export function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

export function Blocked({
  text,
  actionLabel,
  onAction,
  onClose,
  busy,
}: {
  text: string;
  actionLabel?: string;
  onAction?: () => void;
  onClose: () => void;
  busy?: boolean;
}) {
  return (
    <>
      <p style={{ color: COLORS.textDim, fontSize: 13, lineHeight: 1.55, margin: '12px 0 18px' }}>{text}</p>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onClose} style={ghost}>
          Close
        </button>
        {actionLabel && onAction && (
          <button onClick={onAction} disabled={busy} style={accent(!busy)}>
            {busy ? '…' : actionLabel}
          </button>
        )}
      </div>
    </>
  );
}

export const inp: React.CSSProperties = { background: 'var(--inset)', border: '1px solid var(--line)', borderRadius: 9, padding: '10px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--mono)' };
export const ghost: React.CSSProperties = { background: 'transparent', color: 'var(--dim)', border: '1px solid var(--line-2)', borderRadius: 9, padding: '9px 16px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' };
export const xBtn: React.CSSProperties = { background: 'transparent', color: 'var(--dim)', border: '1px solid var(--line)', borderRadius: 9, width: 34, height: 34, fontSize: 18, cursor: 'pointer', flexShrink: 0 };
export function accent(enabled: boolean): React.CSSProperties {
  return { background: 'var(--mint)', color: 'var(--mint-ink)', border: 'none', borderRadius: 9, padding: '9px 18px', fontSize: 12.5, fontWeight: 700, cursor: enabled ? 'pointer' : 'not-allowed', opacity: enabled ? 1 : 0.5 };
}
