import { useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { useVault, VaultView } from '../hooks/useVault';
import { useOwnerActions } from '../hooks/useOwnerActions';
import { useWalletAssets, WalletAsset } from '../hooks/useWalletAssets';
import { BeneficiaryEditor } from '../components/BeneficiaryEditor';
import { BequestsEditor } from '../components/BequestsEditor';
import { Pulse, PulseState } from '../components/Pulse';
import { explorerAddress, explorerTx, getRpcUrl, maskRpc, networkLabel } from '../lib/core';

const LPS = 1_000_000_000;
const short = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;
const sol = (lamports: number) => (lamports / LPS).toFixed(lamports > 0 && lamports < 1e7 ? 4 : 3);

function duration(secs: number): string {
  if (secs <= 0) return 'now';
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m || 1}m`;
}

function isFrozen(v: VaultView): boolean {
  const now = Math.floor(Date.now() / 1000);
  return !v.executed && v.deadline != null && now >= v.deadline;
}

export function MyVaultView() {
  const { connected, publicKey } = useWallet();
  const { vault, exists, loading, error, refresh, svc } = useVault();
  const actions = useOwnerActions(svc, refresh);
  const [editor, setEditor] = useState<null | 'benef' | 'bequests'>(null);

  if (!connected) {
    return (
      <section className="empty panel rise" style={{ overflow: 'hidden', position: 'relative', paddingBottom: 0 }}>
        <p className="eyebrow">Owner console</p>
        <h1 className="h1" style={{ margin: '8px 0 0' }}>Your dead man's switch</h1>
        <p className="lead">
          Connect the wallet that owns your vault to fund it, set who inherits, and watch the switch. It fires only if
          your heartbeats stop.
        </p>
        <div style={{ margin: '26px 0 34px', display: 'flex', justifyContent: 'center' }}>
          <WalletMultiButton />
        </div>
        <div style={{ height: 70, opacity: 0.5 }}>
          <Pulse state="armed" />
        </div>
      </section>
    );
  }

  const canEdit = vault ? !isFrozen(vault) && !vault.executed : false;

  return (
    <>
      <ActionBanner actions={actions} />

      {loading && !vault && <p className="dim" style={{ padding: '8px 2px' }}>Loading your vault…</p>}

      {error && (
        <div className="banner err">
          <p style={{ margin: '0 0 8px' }}>{error}</p>
          <ConnInfo publicKey={publicKey?.toBase58()} />
        </div>
      )}

      {exists === false && !loading && (
        <div className="panel panel-pad rise">
          <h3 style={{ margin: '0 0 6px', fontSize: 15 }}>No vault on this wallet</h3>
          <p className="dim" style={{ fontSize: 13, lineHeight: 1.55, margin: '0 0 14px' }}>
            Connect the <b style={{ color: 'var(--text)' }}>same wallet you created the vault with</b> on your phone, on
            the right network. Vaults are created in the mobile app (it sets up your heartbeat key) — once created, you
            manage them here.
          </p>
          <ConnInfo publicKey={publicKey?.toBase58()} />
        </div>
      )}

      {vault && (
        <>
          <StatusBand v={vault} onRefresh={refresh} />

          <div className="note" style={{ marginBottom: 'var(--gap)' }}>
            <b>Heartbeats stay on your phone.</b> This console manages funds and settings; proving you're alive — and
            creating a vault — happens in the mobile app, where your heartbeat key lives.
          </div>

          <div className="grid">
            <div className="col rise rise-2">
              <AssetsPanel v={vault} actions={actions} />
              {canEdit && <FundPanel v={vault} actions={actions} />}
              {canEdit && <DepositAssetsPanel actions={actions} vaultRefresh={refresh} />}
            </div>
            <div className="col rise rise-3">
              <BeneficiariesPanel v={vault} canEdit={canEdit} onEdit={setEditor} />
              <DangerPanel v={vault} actions={actions} />
            </div>
          </div>

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

/* ── status band (hero) ─────────────────────────────────────────────────── */

function StatusBand({ v, onRefresh }: { v: VaultView; onRefresh: () => void }) {
  const now = Math.floor(Date.now() / 1000);
  const left = v.deadline ? v.deadline - now : null;

  let pulse: PulseState = 'armed';
  let pillCls = 'armed';
  let pillLabel = 'Armed';
  let big = '—';
  let cap = 'until the switch fires';
  let sub = '';

  if (v.executed) {
    pulse = 'flat'; pillCls = 'muted'; pillLabel = 'Distributed'; big = 'Distributed'; cap = 'estate settled';
    sub = 'The estate has been distributed to your beneficiaries.';
  } else if (left !== null && left <= 0) {
    pulse = 'flat'; pillCls = 'frozen'; pillLabel = 'Firing'; big = 'Grace elapsed'; cap = 'distribution pending';
    sub = 'The grace period has elapsed. Distribution is pending and owner changes are locked.';
  } else if (left !== null) {
    big = duration(left);
    if (left < 86400) {
      pulse = 'warn'; pillCls = 'warn'; pillLabel = 'Overdue';
      sub = 'Grace is nearly up — check in from the app to reset the switch.';
    } else {
      sub = 'The switch is armed. It fires if you stop checking in; every heartbeat from the app resets it.';
    }
  } else {
    pulse = 'armed'; pillCls = 'muted'; pillLabel = 'Setup'; cap = 'awaiting first heartbeat';
    sub = 'No heartbeat recorded yet — check in from the app to arm the switch.';
  }

  const nfts = v.tokens.filter((t) => t.isNft).length;
  const toks = v.tokens.filter((t) => !t.isNft).length;
  const parts = [`${toks} token${toks === 1 ? '' : 's'}`, `${nfts} NFT${nfts === 1 ? '' : 's'}`].join(' · ');

  return (
    <div className="band rise rise-1">
      <div className="panel statuscard">
        <div className="status-top">
          <span className={`pill ${pillCls}`}>
            <span className={`dot ${pulse === 'flat' ? 'still' : ''}`} />
            {pillLabel}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={onRefresh}>Refresh</button>
        </div>
        <div>
          <p className="eyebrow">{cap}</p>
          <div className="countdown">{big}</div>
          <p className="status-sub">{sub}</p>
        </div>
        <div className="status-meta">
          <span>grace <b>{duration(v.gracePeriod)}</b></span>
          <span>{v.isMutable ? 'editable' : 'locked'}</span>
          {v.hasAssetPlan && <span>{v.planAssignments} bequest{v.planAssignments === 1 ? '' : 's'}</span>}
        </div>
        <div className="pulsewrap">
          <Pulse state={pulse} />
        </div>
      </div>

      <div className="panel valuecard">
        <p className="eyebrow">Total in vault</p>
        <div className="value-num">{sol(v.solLamports)} SOL</div>
        <div className="value-sub">{parts}</div>
        <a className="value-addr" href={explorerAddress(v.vaultPda)} target="_blank" rel="noreferrer">
          {short(v.vaultPda)} ↗
        </a>
      </div>
    </div>
  );
}

/* ── assets ─────────────────────────────────────────────────────────────── */

function AssetsPanel({ v, actions }: { v: VaultView; actions: ReturnType<typeof useOwnerActions> }) {
  const canWithdraw = !isFrozen(v) && !v.executed;
  return (
    <div className="panel">
      <div className="panel-hd"><h3 className="eyebrow">Assets in vault</h3></div>
      <div className="rows">
        <div className="row">
          <div className="asset">
            <div className="thumb">◎</div>
            <div style={{ minWidth: 0 }}>
              <div className="name">Solana</div>
              <div className="asset-sub sub">SOL</div>
            </div>
          </div>
          <span className="amt">{sol(v.solLamports)}</span>
        </div>
        {v.tokens.map((t) => (
          <div className="row" key={t.mint}>
            <div className="asset">
              <Thumb image={t.image} label={t.symbol || t.name || t.mint} />
              <div style={{ minWidth: 0 }}>
                <div className="name">
                  {t.name || t.symbol || short(t.mint)}
                  {t.isNft && <span className="pill armed" style={{ marginLeft: 7, fontSize: 9.5, padding: '1px 7px' }}>NFT</span>}
                </div>
                <a className="sub" href={explorerAddress(t.mint)} target="_blank" rel="noreferrer">{short(t.mint)}</a>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span className="amt">{t.isNft ? '1' : t.uiAmount}</span>
              {canWithdraw && (
                <button className="btn btn-soft btn-sm" disabled={!!actions.state.busy} onClick={() => actions.withdrawToken(t.mint, t.amount)}>
                  Withdraw
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FundPanel({ v, actions }: { v: VaultView; actions: ReturnType<typeof useOwnerActions> }) {
  const [amt, setAmt] = useState('');
  const busy = !!actions.state.busy;
  const n = parseFloat(amt);
  const ok = n > 0;
  return (
    <div className="panel">
      <div className="panel-hd"><h3 className="eyebrow">Add / withdraw SOL</h3></div>
      <div className="panel-pad">
        <div className="field">
          <input className="input" value={amt} onChange={(e) => setAmt(e.target.value)} inputMode="decimal" placeholder="Amount in SOL" />
          <button className="btn btn-accent" disabled={busy || !ok} onClick={() => { actions.depositSol(n); setAmt(''); }}>Deposit</button>
          <button className="btn btn-soft" disabled={busy || !ok} onClick={() => { actions.withdrawSol(n); setAmt(''); }}>Withdraw</button>
        </div>
        <p className="dim" style={{ fontSize: 11.5, margin: '10px 0 0' }}>
          Balance {sol(v.solLamports)} SOL — keep a little for rent; withdrawing everything may be rejected.
        </p>
      </div>
    </div>
  );
}

function DepositAssetsPanel({ actions, vaultRefresh }: { actions: ReturnType<typeof useOwnerActions>; vaultRefresh: () => Promise<void> }) {
  const { assets, loading, refresh, svc } = useWalletAssets();
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ mint: string; text: string; kind: 'err' | 'warn' } | null>(null);
  const busy = !!actions.state.busy;

  async function deposit(a: WalletAsset) {
    setMsg(null);
    const edited = amounts[a.mint] !== undefined;
    const raw = a.isNft
      ? 1n
      : edited
        ? BigInt(Math.round((parseFloat(amounts[a.mint]) || 0) * 10 ** a.decimals))
        : a.amount;
    if (raw <= 0n) return setMsg({ mint: a.mint, text: 'Enter an amount above 0.', kind: 'err' });
    if (raw > a.amount) return setMsg({ mint: a.mint, text: "That's more than your balance.", kind: 'err' });
    try {
      const chk = await svc.checkDepositable(new PublicKey(a.mint));
      if (!chk.ok) return setMsg({ mint: a.mint, text: chk.reason ?? 'This asset cannot be deposited.', kind: 'err' });
      if (chk.warning) setMsg({ mint: a.mint, text: chk.warning, kind: 'warn' });
    } catch {
      /* let the tx be the source of truth */
    }
    await actions.depositToken(a.mint, raw);
    await Promise.all([refresh(), vaultRefresh()]);
  }

  return (
    <div className="panel">
      <div className="panel-hd"><h3 className="eyebrow">Deposit from your wallet</h3></div>
      {loading && assets.length === 0 && <p className="dim panel-pad" style={{ fontSize: 13, margin: 0 }}>Loading your assets…</p>}
      {!loading && assets.length === 0 && <p className="dim panel-pad" style={{ fontSize: 13, margin: 0 }}>No SPL tokens or NFTs in this wallet to deposit.</p>}
      <div className="rows">
        {assets.map((a) => (
          <div key={a.mint} style={{ borderTop: '1px solid var(--line)' }}>
            <div className="row" style={{ borderTop: 0 }}>
              <div className="asset">
                <Thumb image={a.image} label={a.symbol || a.name || a.mint} />
                <div style={{ minWidth: 0 }}>
                  <div className="name">
                    {a.name || a.symbol || short(a.mint)}
                    {a.isNft && <span className="pill armed" style={{ marginLeft: 7, fontSize: 9.5, padding: '1px 7px' }}>NFT</span>}
                  </div>
                  <a className="sub" href={explorerAddress(a.mint)} target="_blank" rel="noreferrer">
                    {a.isNft ? '1 NFT' : `${a.uiAmount}${a.symbol ? ' ' + a.symbol : ''}`}
                  </a>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
                {!a.isNft && (
                  <input
                    className="input"
                    style={{ width: 104, padding: '8px 10px', fontSize: 12.5 }}
                    value={amounts[a.mint] ?? String(a.uiAmount)}
                    onChange={(e) => setAmounts((m) => ({ ...m, [a.mint]: e.target.value }))}
                    inputMode="decimal"
                  />
                )}
                <button className="btn btn-accent btn-sm" disabled={busy} onClick={() => deposit(a)}>Deposit</button>
              </div>
            </div>
            {msg?.mint === a.mint && (
              <p style={{ fontSize: 11.5, margin: '0 20px 12px', color: msg.kind === 'err' ? 'var(--red)' : 'var(--amber)' }}>{msg.text}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── beneficiaries + bequests ───────────────────────────────────────────── */

function BeneficiariesPanel({ v, canEdit, onEdit }: { v: VaultView; canEdit: boolean; onEdit: (w: 'benef' | 'bequests') => void }) {
  return (
    <div className="panel">
      <div className="panel-hd">
        <h3 className="eyebrow">Beneficiaries</h3>
        {canEdit && <button className="btn btn-soft btn-sm" onClick={() => onEdit('benef')}>Edit</button>}
      </div>
      <div className="rows">
        {v.beneficiaries.map((b) => (
          <div className="benef" key={b.wallet}>
            <a href={explorerAddress(b.wallet)} target="_blank" rel="noreferrer">{short(b.wallet)}</a>
            <span className="share">{(b.shareBps / 100).toFixed(b.shareBps % 100 ? 2 : 0)}%</span>
          </div>
        ))}
      </div>
      <div className="panel-hd" style={{ borderTop: '1px solid var(--line)', borderBottom: 0 }}>
        <div style={{ fontSize: 12.5 }}>
          <span className="dim">Specific bequests · </span>
          <b>{v.hasAssetPlan ? `${v.planAssignments} set` : 'none'}</b>
        </div>
        {canEdit && <button className="btn btn-soft btn-sm" onClick={() => onEdit('bequests')}>{v.hasAssetPlan ? 'Edit' : 'Add'}</button>}
      </div>
    </div>
  );
}

/* ── danger zone ────────────────────────────────────────────────────────── */

function DangerPanel({ v, actions }: { v: VaultView; actions: ReturnType<typeof useOwnerActions> }) {
  const busy = !!actions.state.busy;
  const frozen = isFrozen(v);
  const [confirm, setConfirm] = useState<string | null>(null);

  const rows = [
    { key: 'clear', label: 'Clear bequests', hint: 'Remove the specific-asset plan so you can edit beneficiaries again.', run: actions.clearBequests, show: v.hasAssetPlan && !frozen && !v.executed },
    { key: 'revoke', label: 'Revoke vault', hint: 'Close the vault; all rent and assets return to you. Editable, pre-grace only.', run: actions.revoke, show: v.active && v.isMutable && !frozen && !v.executed },
    { key: 'close', label: 'Close & reclaim rent', hint: 'The estate has been distributed — close the account and reclaim its rent.', run: actions.closeExecuted, show: v.executed && v.openTokenDists === 0 },
  ].filter((r) => r.show);

  if (rows.length === 0) return null;

  return (
    <div className="panel" style={{ borderColor: 'color-mix(in srgb, var(--red) 30%, transparent)' }}>
      <div className="panel-hd"><h3 className="eyebrow" style={{ color: 'var(--red)' }}>Danger zone</h3></div>
      <div className="panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {rows.map((r) => (
          <div key={r.key}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{r.label}</span>
              {confirm === r.key ? (
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => { setConfirm(null); r.run(); }}>Confirm</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setConfirm(null)}>Cancel</button>
                </div>
              ) : (
                <button className="btn btn-danger-o btn-sm" disabled={busy} onClick={() => setConfirm(r.key)}>{r.label.split(' ')[0]}</button>
              )}
            </div>
            <p className="dim" style={{ fontSize: 11.5, margin: '5px 0 0', lineHeight: 1.5 }}>{r.hint}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── shared bits ────────────────────────────────────────────────────────── */

function Thumb({ image, label }: { image?: string; label: string }) {
  const [broken, setBroken] = useState(false);
  if (image && !broken) return <img className="thumb" src={image} alt="" onError={() => setBroken(true)} />;
  return <div className="thumb">{(label || '?').slice(0, 1).toUpperCase()}</div>;
}

function ActionBanner({ actions }: { actions: ReturnType<typeof useOwnerActions> }) {
  const { busy, error, lastSig } = actions.state;
  if (!busy && !error && !lastSig) return null;
  return (
    <div className={`banner ${error ? 'err' : 'ok'}`}>
      {busy && <span>{busy}… approve in your wallet.</span>}
      {error && <span>{error}</span>}
      {lastSig && (
        <span style={{ color: 'var(--mint)' }}>
          Done — <a href={explorerTx(lastSig)} target="_blank" rel="noreferrer" style={{ color: 'var(--mint)' }}>view transaction ↗</a>
        </span>
      )}
    </div>
  );
}

function ConnInfo({ publicKey }: { publicKey?: string }) {
  return (
    <div className="mono" style={{ fontSize: 11.5, color: 'var(--dim)', lineHeight: 1.6, wordBreak: 'break-all' }}>
      <div>connected <span style={{ color: 'var(--text)' }}>{publicKey ?? '—'}</span></div>
      <div>network <span style={{ color: 'var(--text)' }}>{networkLabel()}</span> · {maskRpc(getRpcUrl())}</div>
    </div>
  );
}
