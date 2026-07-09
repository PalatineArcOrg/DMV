import { FC } from 'react';
import { Inheritance } from '../lib/discovery';
import { COLORS, STATUS_META } from '../lib/theme';
import { explorerAddress } from '../lib/core';

function shortKey(k: string) {
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

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

interface Props {
  item: Inheritance;
  busy: boolean;
  onClaim: (owner: string) => void;
}

export const InheritanceCard: FC<Props> = ({ item, busy, onClaim }) => {
  const meta = STATUS_META[item.status] ?? STATUS_META.active;
  const claimable = item.status === 'claimable';

  return (
    <div
      style={{
        background: COLORS.surface,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 12,
        padding: '18px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12.5, color: COLORS.textDim }}>Estate of</span>
          <a
            href={explorerAddress(item.owner)}
            target="_blank"
            rel="noreferrer"
            style={{ color: COLORS.text, fontWeight: 600, fontSize: 15, textDecoration: 'none' }}
          >
            {shortKey(item.owner)}
          </a>
        </div>
        <span
          style={{
            color: meta.color,
            border: `1px solid ${meta.color}`,
            borderRadius: 999,
            padding: '3px 12px',
            fontSize: 11.5,
            fontWeight: 600,
            whiteSpace: 'nowrap',
          }}
        >
          {meta.label}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 24, fontSize: 13 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ color: COLORS.textDim, fontSize: 11.5 }}>Your share</span>
          <span style={{ color: COLORS.text, fontWeight: 600 }}>{(item.shareBps / 100).toFixed(item.shareBps % 100 ? 2 : 0)}%</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ color: COLORS.textDim, fontSize: 11.5 }}>
            {claimable ? 'Grace elapsed' : 'Claim opens in'}
          </span>
          <span style={{ color: COLORS.text, fontWeight: 600 }}>{claimable ? 'ready' : countdown(item.secondsToDeadline)}</span>
        </div>
      </div>

      <p style={{ margin: 0, color: COLORS.textDim, fontSize: 12.5, lineHeight: 1.5 }}>{meta.hint}</p>

      <button
        disabled={!claimable || busy}
        onClick={() => onClaim(item.owner)}
        style={{
          alignSelf: 'flex-start',
          background: claimable ? COLORS.accent : 'transparent',
          color: claimable ? '#04120B' : COLORS.textDim,
          border: claimable ? 'none' : `1px solid ${COLORS.border}`,
          borderRadius: 8,
          padding: '9px 20px',
          fontSize: 13.5,
          fontWeight: 700,
          cursor: claimable && !busy ? 'pointer' : 'not-allowed',
          opacity: busy ? 0.6 : 1,
        }}
      >
        {busy ? 'Claiming…' : claimable ? 'Claim inheritance' : 'Not claimable yet'}
      </button>
    </div>
  );
};
