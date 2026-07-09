import { FC, useState } from 'react';
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

  const testColor = test.kind === 'ok' ? 'var(--mint)' : test.kind === 'err' ? 'var(--red)' : 'var(--dim)';

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <h2>Network</h2>
          <button className="x" onClick={onClose}>×</button>
        </div>

        <p className="dim" style={{ fontSize: 12.5, lineHeight: 1.5, margin: '0 0 18px' }}>
          Requests use a shared DMV RPC by default. For higher reliability you can use your own endpoint (e.g. a Helius
          URL). Stored only in this browser.
        </p>

        <div className="dim" style={{ fontSize: 12.5, marginBottom: 8 }}>
          Current <span style={{ color: 'var(--text)' }}>{custom ? maskRpc(getRpcUrl()) : 'Default DMV RPC'}</span>{' '}
          <span style={{ color: 'var(--mint)' }}>({networkLabel()})</span>
        </div>

        <p className="eyebrow" style={{ margin: '0 0 6px' }}>Custom RPC URL</p>
        <input
          className="input"
          value={url}
          onChange={(e) => { setUrl(e.target.value); setTest({ kind: 'idle' }); }}
          placeholder="https://devnet.helius-rpc.com/?api-key=…"
          style={{ marginBottom: 10 }}
        />

        {test.kind !== 'idle' && (
          <p style={{ fontSize: 12, margin: '0 0 10px', color: testColor }}>
            {test.kind === 'testing' ? 'Testing…' : test.msg}
          </p>
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-soft" onClick={runTest} disabled={!url.trim() || test.kind === 'testing'}>Test</button>
          <button className="btn btn-accent" onClick={save} disabled={!url.trim()}>Save &amp; reload</button>
          {custom && <button className="btn btn-ghost" onClick={reset}>Reset to default</button>}
        </div>
      </div>
    </div>
  );
};
