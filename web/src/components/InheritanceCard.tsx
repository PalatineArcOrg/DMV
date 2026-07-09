import { FC } from 'react';
import { Inheritance } from '../lib/discovery';
import { STATUS_META } from '../lib/theme';
import { explorerAddress } from '../lib/core';

const shortKey = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;

function countdown(secs: number | null): string {
  if (secs === null) return '—';
  if (secs <= 0) return 'now';
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const PILL: Record<string, string> = { active: 'muted', warning: 'warn', claimable: 'armed', executed: 'muted' };

interface Props {
  item: Inheritance;
  busy: boolean;
  onClaim: (owner: string) => void;
}

export const InheritanceCard: FC<Props> = ({ item, busy, onClaim }) => {
  const meta = STATUS_META[item.status] ?? STATUS_META.active;
  const claimable = item.status === 'claimable';
  const pillCls = PILL[item.status] ?? 'muted';
  const still = item.status === 'executed' || item.status === 'claimable';

  return (
    <div
      className="panel panel-pad"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 15,
        borderColor: claimable ? 'var(--mint-line)' : undefined,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div>
          <p className="eyebrow">Estate of</p>
          <a className="mono" href={explorerAddress(item.owner)} target="_blank" rel="noreferrer"
             style={{ color: 'var(--text)', fontWeight: 600, fontSize: 15, textDecoration: 'none', display: 'inline-block', marginTop: 4 }}>
            {shortKey(item.owner)}
          </a>
        </div>
        <span className={`pill ${pillCls}`}><span className={`dot ${still ? 'still' : ''}`} />{meta.label}</span>
      </div>

      <div style={{ display: 'flex', gap: 30 }}>
        <div>
          <p className="eyebrow">Your share</p>
          <div className="amt" style={{ fontSize: 20, marginTop: 3, color: 'var(--mint)' }}>{(item.shareBps / 100).toFixed(item.shareBps % 100 ? 2 : 0)}%</div>
        </div>
        <div>
          <p className="eyebrow">{claimable ? 'Grace' : 'Claim opens in'}</p>
          <div className="amt" style={{ fontSize: 20, marginTop: 3 }}>{claimable ? 'ready' : countdown(item.secondsToDeadline)}</div>
        </div>
      </div>

      <p className="dim" style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5 }}>{meta.hint}</p>

      <button
        className={`btn ${claimable ? 'btn-accent' : 'btn-ghost'}`}
        style={{ alignSelf: 'flex-start' }}
        disabled={!claimable || busy}
        onClick={() => onClaim(item.owner)}
      >
        {busy ? 'Claiming…' : claimable ? 'Claim inheritance' : 'Not claimable yet'}
      </button>
    </div>
  );
};
