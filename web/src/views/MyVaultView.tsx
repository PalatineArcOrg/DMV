import { useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { useVault, VaultView } from '../hooks/useVault';
import { useOwnerActions } from '../hooks/useOwnerActions';
import { COLORS } from '../lib/theme';
import { explorerAddress, explorerTx } from '../lib/core';

const LPS = 1_000_000_000;
const short = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;
const sol = (lamports: number) => (lamports / LPS).toFixed(4);

function duration(secs: number): string {
  if (secs <= 0) return '0s';
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m || 1}m`;
}

export function MyVaultView() {
  const { connected } = useWallet();
  const { vault, exists, loading, error, refresh, svc } = useVault();
  const actions = useOwnerActions(svc, refresh);

  if (!connected) {
    return (
      <>
        <h1 style={{ fontSize: 30, fontWeight: 700, margin: '0 0 8px' }}>Your vault</h1>
        <p style={{ color: COLORS.textDim, fontSize: 14.5, margin: '0 0 24px' }}>
          Connect your wallet to view and manage the vault you own.
        </p>
        <div style={card('center')}>
          <p style={{ color: COLORS.textDim, margin: '0 0 18px' }}>Connect a wallet to get started.</p>
          <WalletMultiButton />
        </div>
      </>
    );
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <h1 style={{ fontSize: 30, fontWeight: 700, margin: 0 }}>Your vault</h1>
        <button onClick={refresh} style={ghostBtn}>
          Refresh
        </button>
      </div>

      <PhoneNote />

      {loading && !vault && <p style={{ color: COLORS.textDim }}>Loading…</p>}
      {error && <p style={{ color: COLORS.warning, fontSize: 13 }}>{error}</p>}

      {exists === false && !loading && (
        <div style={card()}>
          <p style={{ color: COLORS.text, fontWeight: 600, margin: '0 0 6px' }}>No vault found for this wallet.</p>
          <p style={{ color: COLORS.textDim, fontSize: 13, lineHeight: 1.5, margin: 0 }}>
            Creating a vault sets up your device's heartbeat key, so it's done in the{' '}
            <b style={{ color: COLORS.text }}>Dead Man's Vault mobile app</b>. Once created, you can fund and manage
            it here from any browser wallet.
          </p>
        </div>
      )}

      {vault && (
        <>
          <ActionBanner actions={actions} />
          <StatusCard v={vault} />
          <Beneficiaries v={vault} />
          <Balances v={vault} actions={actions} />
          {!isFrozen(vault) && !vault.executed && <FundPanel v={vault} actions={actions} />}
          <DangerZone v={vault} actions={actions} />
        </>
      )}
    </>
  );
}

/* ---------- sections ---------- */

function StatusCard({ v }: { v: VaultView }) {
  const now = Math.floor(Date.now() / 1000);
  const frozen = isFrozen(v);
  let statusLabel = 'Active';
  let statusColor = COLORS.accent;
  let sub = '';
  if (v.executed) {
    statusLabel = 'Distributed';
    statusColor = COLORS.textDim;
    sub = 'The estate has been distributed to your beneficiaries.';
  } else if (frozen) {
    statusLabel = 'Frozen';
    statusColor = COLORS.critical;
    sub = 'Grace elapsed — distribution is pending and owner changes are locked.';
  } else if (v.deadline) {
    sub = `Switch fires in ${duration(v.deadline - now)} if you stop checking in (resets each heartbeat from the app).`;
  } else {
    sub = 'No heartbeat recorded yet.';
  }

  return (
    <div style={card()}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <span style={pill(statusColor)}>{statusLabel}</span>
        <a href={explorerAddress(v.vaultPda)} target="_blank" rel="noreferrer" style={{ color: COLORS.textDim, fontSize: 12, textDecoration: 'none', fontFamily: 'monospace' }}>
          {short(v.vaultPda)} ↗
        </a>
      </div>
      <div style={{ fontSize: 26, fontWeight: 700 }}>{sol(v.solLamports)} SOL</div>
      <p style={{ color: COLORS.textDim, fontSize: 12.5, lineHeight: 1.5, margin: '8px 0 0' }}>{sub}</p>
      <div style={{ display: 'flex', gap: 16, marginTop: 12, flexWrap: 'wrap', fontSize: 12, color: COLORS.textDim }}>
        <span>Grace: {duration(v.gracePeriod)}</span>
        <span>{v.isMutable ? 'Editable' : 'Locked (immutable)'}</span>
        {v.hasAssetPlan && <span>{v.planAssignments} bequest{v.planAssignments === 1 ? '' : 's'}</span>}
      </div>
    </div>
  );
}

function Beneficiaries({ v }: { v: VaultView }) {
  return (
    <div style={card()}>
      <h3 style={sectionTitle}>Beneficiaries</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {v.beneficiaries.map((b) => (
          <div key={b.wallet} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <a href={explorerAddress(b.wallet)} target="_blank" rel="noreferrer" style={{ color: COLORS.text, textDecoration: 'none', fontFamily: 'monospace' }}>
              {short(b.wallet)}
            </a>
            <span style={{ color: COLORS.accent, fontWeight: 600 }}>{(b.shareBps / 100).toFixed(b.shareBps % 100 ? 2 : 0)}%</span>
          </div>
        ))}
      </div>
      <p style={{ color: COLORS.textDim, fontSize: 11.5, margin: '12px 0 0', lineHeight: 1.5 }}>
        Editing beneficiaries and bequests is coming to the web console — for now, use the mobile app.
      </p>
    </div>
  );
}

function Balances({ v, actions }: { v: VaultView; actions: ReturnType<typeof useOwnerActions> }) {
  const canWithdraw = !isFrozen(v) && !v.executed;
  if (v.tokens.length === 0) return null;
  return (
    <div style={card()}>
      <h3 style={sectionTitle}>Tokens in vault</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {v.tokens.map((t) => (
          <div key={t.mint} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontWeight: 600 }}>{t.uiAmount}</span>
              <a href={explorerAddress(t.mint)} target="_blank" rel="noreferrer" style={{ color: COLORS.textDim, fontSize: 11, textDecoration: 'none', fontFamily: 'monospace' }}>
                {short(t.mint)}
              </a>
            </div>
            {canWithdraw && (
              <button
                onClick={() => actions.withdrawToken(t.mint, t.amount)}
                disabled={!!actions.state.busy}
                style={smallBtn}
              >
                Withdraw
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function FundPanel({ v, actions }: { v: VaultView; actions: ReturnType<typeof useOwnerActions> }) {
  const [dep, setDep] = useState('');
  const [wd, setWd] = useState('');
  const busy = !!actions.state.busy;
  return (
    <div style={card()}>
      <h3 style={sectionTitle}>Fund / withdraw SOL</h3>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <input value={dep} onChange={(e) => setDep(e.target.value)} inputMode="decimal" placeholder="Amount to deposit" style={input} />
        <button onClick={() => { actions.depositSol(parseFloat(dep)); setDep(''); }} disabled={busy || !(parseFloat(dep) > 0)} style={accentBtn(!busy && parseFloat(dep) > 0)}>
          Deposit
        </button>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input value={wd} onChange={(e) => setWd(e.target.value)} inputMode="decimal" placeholder="Amount to withdraw" style={input} />
        <button onClick={() => { actions.withdrawSol(parseFloat(wd)); setWd(''); }} disabled={busy || !(parseFloat(wd) > 0)} style={neutralBtn(!busy && parseFloat(wd) > 0)}>
          Withdraw
        </button>
      </div>
      <p style={{ color: COLORS.textDim, fontSize: 11.5, margin: '10px 0 0' }}>
        Balance: {sol(v.solLamports)} SOL. Keep a little for rent; withdrawing everything may be rejected.
      </p>
    </div>
  );
}

function DangerZone({ v, actions }: { v: VaultView; actions: ReturnType<typeof useOwnerActions> }) {
  const busy = !!actions.state.busy;
  const frozen = isFrozen(v);
  const [confirm, setConfirm] = useState<string | null>(null);

  const rows: { key: string; label: string; hint: string; run: () => void; show: boolean }[] = [
    {
      key: 'clear',
      label: 'Clear bequests',
      hint: 'Remove the specific-asset plan so you can edit beneficiaries again.',
      run: actions.clearBequests,
      show: v.hasAssetPlan && !frozen && !v.executed,
    },
    {
      key: 'revoke',
      label: 'Revoke vault',
      hint: 'Close the vault, return all rent + assets to you. Only while editable and before grace.',
      run: actions.revoke,
      show: v.active && v.isMutable && !frozen && !v.executed,
    },
    {
      key: 'close',
      label: 'Close vault & reclaim rent',
      hint: 'The estate has been distributed — close the account and reclaim its rent.',
      run: actions.closeExecuted,
      show: v.executed && v.openTokenDists === 0,
    },
  ].filter((r) => r.show);

  if (rows.length === 0) return null;

  return (
    <div style={{ ...card(), borderColor: 'rgba(239,68,68,0.35)' }}>
      <h3 style={{ ...sectionTitle, color: COLORS.critical }}>Danger zone</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {rows.map((r) => (
          <div key={r.key}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{r.label}</span>
              {confirm === r.key ? (
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => { setConfirm(null); r.run(); }} disabled={busy} style={dangerBtn}>
                    Confirm
                  </button>
                  <button onClick={() => setConfirm(null)} style={smallBtn}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button onClick={() => setConfirm(r.key)} disabled={busy} style={dangerOutlineBtn}>
                  {r.label.split(' ')[0]}
                </button>
              )}
            </div>
            <p style={{ color: COLORS.textDim, fontSize: 11.5, margin: '4px 0 0', lineHeight: 1.5 }}>{r.hint}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function ActionBanner({ actions }: { actions: ReturnType<typeof useOwnerActions> }) {
  const { busy, error, lastSig } = actions.state;
  if (!busy && !error && !lastSig) return null;
  return (
    <div
      style={{
        ...card(),
        borderColor: error ? COLORS.critical : COLORS.accent,
        padding: '12px 16px',
      }}
    >
      {busy && <span style={{ fontSize: 13 }}>{busy}… approve in your wallet.</span>}
      {error && <span style={{ fontSize: 13, color: COLORS.critical }}>{error}</span>}
      {lastSig && (
        <span style={{ fontSize: 13, color: COLORS.accent }}>
          Done ✅{' '}
          <a href={explorerTx(lastSig)} target="_blank" rel="noreferrer" style={{ color: COLORS.accent }}>
            view tx ↗
          </a>
        </span>
      )}
    </div>
  );
}

function PhoneNote() {
  return (
    <div
      style={{
        background: 'rgba(0,255,163,0.06)',
        border: `1px solid rgba(0,255,163,0.25)`,
        borderRadius: 10,
        padding: '10px 14px',
        margin: '0 0 20px',
        fontSize: 12.5,
        color: COLORS.textDim,
        lineHeight: 1.5,
      }}
    >
      <b style={{ color: COLORS.text }}>Heartbeats stay on your phone.</b> This console manages funds and settings,
      but proving you're alive (and creating a vault) happens in the mobile app, where your heartbeat key lives.
    </div>
  );
}

/* ---------- helpers ---------- */

function isFrozen(v: VaultView): boolean {
  const now = Math.floor(Date.now() / 1000);
  return !v.executed && v.deadline != null && now >= v.deadline;
}

const card = (align?: 'center'): React.CSSProperties => ({
  background: COLORS.surface,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 12,
  padding: 20,
  marginBottom: 16,
  textAlign: align === 'center' ? 'center' : 'left',
});
const sectionTitle: React.CSSProperties = { fontSize: 13, fontWeight: 600, color: COLORS.textDim, margin: '0 0 12px', textTransform: 'uppercase', letterSpacing: 0.5 };
const pill = (c: string): React.CSSProperties => ({ color: c, border: `1px solid ${c}`, borderRadius: 999, padding: '3px 12px', fontSize: 11.5, fontWeight: 600 });
const input: React.CSSProperties = { flex: 1, background: COLORS.bg, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: '10px 12px', color: COLORS.text, fontSize: 13 };
const ghostBtn: React.CSSProperties = { background: 'transparent', color: COLORS.textDim, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: '6px 14px', fontSize: 12.5, cursor: 'pointer' };
const smallBtn: React.CSSProperties = { background: COLORS.surfaceHi, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 7, padding: '7px 14px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' };
const dangerOutlineBtn: React.CSSProperties = { background: 'transparent', color: COLORS.critical, border: `1px solid ${COLORS.critical}`, borderRadius: 7, padding: '7px 14px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' };
const dangerBtn: React.CSSProperties = { background: COLORS.critical, color: '#fff', border: 'none', borderRadius: 7, padding: '7px 14px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' };
function accentBtn(enabled: boolean): React.CSSProperties {
  return { background: COLORS.accent, color: '#04120B', border: 'none', borderRadius: 8, padding: '10px 18px', fontSize: 13, fontWeight: 700, cursor: enabled ? 'pointer' : 'not-allowed', opacity: enabled ? 1 : 0.5 };
}
function neutralBtn(enabled: boolean): React.CSSProperties {
  return { background: COLORS.surfaceHi, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: '10px 18px', fontSize: 13, fontWeight: 700, cursor: enabled ? 'pointer' : 'not-allowed', opacity: enabled ? 1 : 0.5 };
}
