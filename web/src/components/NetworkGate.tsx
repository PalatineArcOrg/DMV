import type { CSSProperties } from 'react';
import type { NetworkVerification } from '../lib/core';

interface NetworkGateProps {
  verification: NetworkVerification | null;
  busy: boolean;
  /** Re-run the genesis check. */
  onRetry: () => void;
  /** Proceed despite an UNKNOWN (unverifiable) network. Provided only for UNKNOWN —
   *  MISMATCH is a hard block with no continue path. */
  onContinue?: () => void;
}

function shortHash(h?: string | null): string {
  if (!h) return '—';
  return h.length > 18 ? `${h.slice(0, 8)}…${h.slice(-8)}` : h;
}

const wrap: CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
};
const card: CSSProperties = {
  width: '100%',
  maxWidth: 460,
  background: 'var(--card)',
  border: '1px solid var(--line)',
  borderRadius: 'var(--r)',
  padding: 28,
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
};
const row: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 12,
};
const btn: CSSProperties = {
  padding: '12px 16px',
  borderRadius: 'var(--r-sm)',
  border: '1px solid transparent',
  cursor: 'pointer',
  fontFamily: 'var(--sans)',
  fontSize: 15,
  fontWeight: 600,
};

export function NetworkGate({ verification, busy, onRetry, onContinue }: NetworkGateProps) {
  if (!verification) {
    return (
      <div style={wrap}>
        <div style={{ ...card, alignItems: 'center' }}>
          <span className="dim">Verifying network…</span>
        </div>
      </div>
    );
  }

  const isMismatch = verification.state === 'MISMATCH';
  const accent = isMismatch ? 'var(--red)' : 'var(--amber)';
  const title = isMismatch ? 'Wrong Network' : 'Network Unverified';
  const message = isMismatch
    ? `This build expects ${verification.expectedCluster}, but the connected RPC is serving a different Solana cluster. To protect your vault, the console will not continue on the wrong network.`
    : `Couldn't reach the RPC to verify which Solana network it serves. Check your connection and retry, or switch to a different RPC in Settings.`;

  return (
    <div style={wrap}>
      <div style={card}>
        <span
          style={{
            alignSelf: 'flex-start',
            padding: '4px 10px',
            borderRadius: 6,
            border: `1px solid ${accent}`,
            color: accent,
            background: isMismatch ? 'rgba(255,93,93,0.1)' : 'rgba(245,165,36,0.1)',
            fontSize: 11,
            letterSpacing: 1,
            fontWeight: 600,
          }}
        >
          {isMismatch ? 'BLOCKED' : 'UNVERIFIED'}
        </span>

        <h1 style={{ margin: 0, fontSize: 24, color: 'var(--text)' }}>{title}</h1>
        <p style={{ margin: 0, color: 'var(--dim)', fontSize: 14, lineHeight: 1.5 }}>{message}</p>

        <div style={row}>
          <span className="dim" style={{ fontSize: 12 }}>Expected</span>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{verification.expectedCluster}</span>
        </div>
        {isMismatch && (
          <>
            <div style={row}>
              <span className="dim" style={{ fontSize: 12 }}>Expected genesis</span>
              <span className="mono" style={{ fontSize: 12 }}>{shortHash(verification.expectedGenesis)}</span>
            </div>
            <div style={row}>
              <span className="dim" style={{ fontSize: 12 }}>RPC genesis</span>
              <span className="mono" style={{ fontSize: 12 }}>{shortHash(verification.receivedGenesis)}</span>
            </div>
          </>
        )}

        {busy ? (
          <div style={{ ...row, justifyContent: 'center', padding: '10px 0' }}>
            <span className="dim">Checking network…</span>
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={onRetry}
              style={{ ...btn, marginTop: 6, background: 'var(--mint)', color: 'var(--mint-ink)' }}
            >
              Retry
            </button>
            {onContinue && (
              <button
                type="button"
                onClick={onContinue}
                style={{ ...btn, background: 'transparent', borderColor: 'var(--line-2)', color: 'var(--dim)' }}
              >
                Continue anyway
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
