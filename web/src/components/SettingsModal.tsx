import { FC, useState } from 'react';
import { COLORS } from '../lib/theme';
import {
  getRpcUrl,
  isCustomRpc,
  maskRpc,
  networkLabel,
  DEFAULT_RPC_URL,
  RPC_OVERRIDE_KEY,
} from '../lib/core';
import { setSetting, clearSetting } from '../lib/settings';

type TestState = { kind: 'idle' | 'testing' | 'ok' | 'err'; msg?: string };

export const SettingsModal: FC<{ onClose: () => void }> = ({ onClose }) => {
  const custom = isCustomRpc();
  const [url, setUrl] = useState(custom ? getRpcUrl() : '');
  const [test, setTest] = useState<TestState>({ kind: 'idle' });

  async function runTest() {
    const target = url.trim();
    if (!target) return;
    setTest({ kind: 'testing' });
    try {
      const res = await fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getVersion' }),
      });
      const json = await res.json();
      const v = json?.result?.['solana-core'];
      if (v) setTest({ kind: 'ok', msg: `Connected — solana-core ${v}` });
      else setTest({ kind: 'err', msg: 'Reachable, but no version in response.' });
    } catch (e) {
      setTest({ kind: 'err', msg: e instanceof Error ? e.message : 'Could not reach RPC.' });
    }
  }

  function save() {
    const v = url.trim();
    if (!v) return;
    if (!/^https:\/\//i.test(v)) {
      setTest({ kind: 'err', msg: 'RPC URL must start with https://' });
      return;
    }
    setSetting(RPC_OVERRIDE_KEY, v);
    location.reload(); // "restart to apply" — override loads at bootstrap
  }

  function reset() {
    clearSetting(RPC_OVERRIDE_KEY);
    location.reload();
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: COLORS.surface,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 14,
          padding: 24,
          width: '100%',
          maxWidth: 460,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <h2 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>Network</h2>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: COLORS.textDim, fontSize: 20, cursor: 'pointer' }}
          >
            ×
          </button>
        </div>

        <p style={{ color: COLORS.textDim, fontSize: 12.5, lineHeight: 1.5, margin: '0 0 18px' }}>
          Requests use a shared DMV RPC by default. For higher reliability you can use your own RPC endpoint
          (e.g. a Helius URL). Stored only in this browser.
        </p>

        <div style={{ fontSize: 12.5, color: COLORS.textDim, marginBottom: 6 }}>
          Current: <span style={{ color: COLORS.text }}>{custom ? maskRpc(getRpcUrl()) : 'Default DMV RPC'}</span>{' '}
          <span style={{ color: COLORS.accent }}>({networkLabel()})</span>
        </div>

        <label style={{ fontSize: 12.5, color: COLORS.textDim, display: 'block', marginBottom: 6 }}>
          Custom RPC URL
        </label>
        <input
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setTest({ kind: 'idle' });
          }}
          placeholder="https://devnet.helius-rpc.com/?api-key=…"
          style={{
            width: '100%',
            background: COLORS.bg,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 8,
            padding: '10px 12px',
            color: COLORS.text,
            fontSize: 12.5,
            fontFamily: 'monospace',
            marginBottom: 10,
          }}
        />

        {test.kind !== 'idle' && (
          <p
            style={{
              fontSize: 12,
              margin: '0 0 10px',
              color:
                test.kind === 'ok' ? COLORS.accent : test.kind === 'err' ? COLORS.critical : COLORS.textDim,
            }}
          >
            {test.kind === 'testing' ? 'Testing…' : test.msg}
          </p>
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            onClick={runTest}
            disabled={!url.trim() || test.kind === 'testing'}
            style={btn(COLORS.surfaceHi, COLORS.text, !!url.trim())}
          >
            Test
          </button>
          <button onClick={save} disabled={!url.trim()} style={btn(COLORS.accent, '#04120B', !!url.trim())}>
            Save & reload
          </button>
          {custom && (
            <button onClick={reset} style={btn('transparent', COLORS.textDim, true)}>
              Reset to default
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

function btn(bg: string, color: string, enabled: boolean): React.CSSProperties {
  return {
    background: bg,
    color,
    border: bg === 'transparent' ? `1px solid ${COLORS.border}` : 'none',
    borderRadius: 8,
    padding: '9px 16px',
    fontSize: 12.5,
    fontWeight: 700,
    cursor: enabled ? 'pointer' : 'not-allowed',
    opacity: enabled ? 1 : 0.5,
  };
}
