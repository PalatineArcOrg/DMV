import { useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { useVault, VaultView } from '../hooks/useVault';
import { useOwnerActions } from '../hooks/useOwnerActions';
import { useWalletAssets, WalletAsset } from '../hooks/useWalletAssets';
import { BeneficiaryEditor } from '../components/BeneficiaryEditor';
import { BequestsEditor } from '../components/BequestsEditor';
import { COLORS } from '../lib/theme';
import { explorerAddress, explorerTx, getRpcUrl, maskRpc, networkLabel } from '../lib/core';

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
  const { connected, publicKey } = useWallet();
  const { vault, exists, loading, error, refresh, svc } = useVault();
  const actions = useOwnerActions(svc, refresh);
  const [editor, setEditor] = useState<null | 'benef' | 'bequests'>(null);

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
      {error && (
        <div style={{ ...card(), borderColor: COLORS.critical }}>
          <p style={{ color: COLORS.critical, fontSize: 13, margin: '0 0 8px' }}>{error}</p>
          <ConnInfo publicKey={publicKey?.toBase58()} />
        </div>
      )}

      {exists === false && !loading && (
        <div style={card()}>
          <p style={{ color: COLORS.text, fontWeight: 600, margin: '0 0 6px' }}>No vault found for this wallet.</p>
          <p style={{ color: COLORS.textDim, fontSize: 13, lineHeight: 1.5, margin: '0 0 12px' }}>
            Make sure you're connected with the <b style={{ color: COLORS.text }}>same wallet you created the vault
            with</b> on your phone, and on the right network. A vault is created in the mobile app (it sets up your
            device's heartbeat key); once created you can manage it here.
          </p>
          <ConnInfo publicKey={publicKey?.toBase58()} />
        </div>
      )}

      {vault && (
        <>
          <ActionBanner actions={actions} />
          <StatusCard v={vault} />
          <Beneficiaries v={vault} canEdit={!isFrozen(vault) && !vault.executed} onEdit={setEditor} />
          <Balances v={vault} actions={actions} />
          {!isFrozen(vault) && !vault.executed && (
            <>
              <FundPanel v={vault} actions={actions} />
              <DepositAssetsPanel actions={actions} vaultRefresh={refresh} />
            </>
          )}
          <DangerZone v={vault} actions={actions} />

          {editor === 'benef' && (
            <BeneficiaryEditor vault={vault} owner={vault.owner} actions={actions} onClose={() => setEditor(null)} />
          )}
          {editor === 'bequests' && (
            <BequestsEditor vault={vault} actions={actions} svc={svc} onClose={() => setEditor(null)} />
          )}
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

function Beneficiaries({ v, canEdit, onEdit }: { v: VaultView; canEdit: boolean; onEdit: (which: 'benef' | 'bequests') => void }) {
  return (
    <div style={card()}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ ...sectionTitle, margin: 0 }}>Beneficiaries</h3>
        {canEdit && (
          <button onClick={() => onEdit('benef')} style={smallBtn}>
            Edit
          </button>
        )}
      </div>
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14, paddingTop: 12, borderTop: `1px solid ${COLORS.border}` }}>
        <div style={{ fontSize: 12.5 }}>
          <span style={{ color: COLORS.textDim }}>Specific bequests: </span>
          <span style={{ color: COLORS.text, fontWeight: 600 }}>{v.hasAssetPlan ? `${v.planAssignments} set` : 'none'}</span>
        </div>
        {canEdit && (
          <button onClick={() => onEdit('bequests')} style={smallBtn}>
            {v.hasAssetPlan ? 'Edit bequests' : 'Add bequests'}
          </button>
        )}
      </div>
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
          <div key={t.mint} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
              <Thumb image={t.image} label={t.symbol || t.name || t.mint} />
              <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <span style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 150 }}>
                  {t.name || t.symbol || short(t.mint)}
                  {t.isNft && <span style={{ ...pill(COLORS.accent), fontSize: 9.5, padding: '1px 7px', marginLeft: 6 }}>NFT</span>}
                </span>
                <a href={explorerAddress(t.mint)} target="_blank" rel="noreferrer" style={{ color: COLORS.textDim, fontSize: 11, textDecoration: 'none' }}>
                  {t.isNft ? '1 NFT' : `${t.uiAmount}${t.symbol ? ' ' + t.symbol : ''}`}
                </a>
              </div>
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

function Thumb({ image, label }: { image?: string; label: string }) {
  const [broken, setBroken] = useState(false);
  const size = 30;
  if (image && !broken) {
    return (
      <img
        src={image}
        alt=""
        width={size}
        height={size}
        onError={() => setBroken(true)}
        style={{ borderRadius: 8, objectFit: 'cover', flexShrink: 0, background: COLORS.surfaceHi }}
      />
    );
  }
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: 8,
        flexShrink: 0,
        background: COLORS.surfaceHi,
        border: `1px solid ${COLORS.border}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 13,
        fontWeight: 700,
        color: COLORS.textDim,
      }}
    >
      {(label || '?').slice(0, 1).toUpperCase()}
    </div>
  );
}

function DepositAssetsPanel({
  actions,
  vaultRefresh,
}: {
  actions: ReturnType<typeof useOwnerActions>;
  vaultRefresh: () => Promise<void>;
}) {
  const { assets, loading, refresh, svc } = useWalletAssets();
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ mint: string; text: string; kind: 'err' | 'warn' } | null>(null);
  const busy = !!actions.state.busy;

  async function deposit(a: WalletAsset) {
    setMsg(null);
    const edited = amounts[a.mint] !== undefined; // untouched field => deposit the exact balance
    const raw = a.isNft
      ? 1n
      : edited
        ? BigInt(Math.round((parseFloat(amounts[a.mint]) || 0) * 10 ** a.decimals))
        : a.amount; // exact bigint — avoids float round-trip through the lossy uiAmount
    if (raw <= 0n) return setMsg({ mint: a.mint, text: 'Enter an amount above 0.', kind: 'err' });
    if (raw > a.amount) return setMsg({ mint: a.mint, text: "That's more than your balance.", kind: 'err' });
    try {
      const chk = await svc.checkDepositable(new PublicKey(a.mint));
      if (!chk.ok) return setMsg({ mint: a.mint, text: chk.reason ?? 'This asset cannot be deposited.', kind: 'err' });
      if (chk.warning) setMsg({ mint: a.mint, text: chk.warning, kind: 'warn' }); // proceed, but inform
    } catch {
      /* if the check itself fails, let the tx be the source of truth */
    }
    await actions.depositToken(a.mint, raw);
    await Promise.all([refresh(), vaultRefresh()]);
  }

  return (
    <div style={card()}>
      <h3 style={sectionTitle}>Deposit from your wallet</h3>
      {loading && assets.length === 0 && <p style={{ color: COLORS.textDim, fontSize: 13 }}>Loading your assets…</p>}
      {!loading && assets.length === 0 && (
        <p style={{ color: COLORS.textDim, fontSize: 13 }}>No SPL tokens or NFTs in this wallet to deposit.</p>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {assets.map((a) => (
          <div key={a.mint} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <Thumb image={a.image} label={a.symbol || a.name || a.mint} />
                <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <span style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 150 }}>
                    {a.name || a.symbol || `${a.mint.slice(0, 4)}…${a.mint.slice(-4)}`}
                    {a.isNft && <span style={{ ...pill(COLORS.accent), fontSize: 9.5, padding: '1px 7px', marginLeft: 6 }}>NFT</span>}
                  </span>
                  <a href={explorerAddress(a.mint)} target="_blank" rel="noreferrer" style={{ color: COLORS.textDim, fontSize: 11, textDecoration: 'none' }}>
                    {a.isNft ? '1 NFT' : `${a.uiAmount}${a.symbol ? ' ' + a.symbol : ''}`}
                  </a>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {!a.isNft && (
                  <input
                    value={amounts[a.mint] ?? String(a.uiAmount)}
                    onChange={(e) => setAmounts((m) => ({ ...m, [a.mint]: e.target.value }))}
                    inputMode="decimal"
                    style={{ ...input, width: 110, flex: 'none', padding: '8px 10px', fontSize: 12.5 }}
                  />
                )}
                <button onClick={() => deposit(a)} disabled={busy} style={accentBtn(!busy)}>
                  Deposit
                </button>
              </div>
            </div>
            {msg?.mint === a.mint && (
              <p style={{ fontSize: 11.5, margin: 0, color: msg.kind === 'err' ? COLORS.critical : COLORS.warning }}>{msg.text}</p>
            )}
          </div>
        ))}
      </div>
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

function ConnInfo({ publicKey }: { publicKey?: string }) {
  return (
    <div style={{ fontSize: 11.5, color: COLORS.textDim, fontFamily: 'monospace', lineHeight: 1.6 }}>
      <div>
        Connected: <span style={{ color: COLORS.text }}>{publicKey ?? '—'}</span>
      </div>
      <div>
        Network: <span style={{ color: COLORS.text }}>{networkLabel()}</span> · {maskRpc(getRpcUrl())}
      </div>
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
