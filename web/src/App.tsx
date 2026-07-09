import { useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { useInheritances } from './hooks/useInheritances';
import { useClaim } from './hooks/useClaim';
import { InheritanceCard } from './components/InheritanceCard';
import { SettingsModal } from './components/SettingsModal';
import { COLORS } from './lib/theme';
import { networkLabel } from './lib/core';

export default function App() {
  const { connected } = useWallet();
  const { items, loading, error, refresh, importByOwner } = useInheritances();
  const { state: claim, claim: runClaim, reset } = useClaim();

  const [ownerInput, setOwnerInput] = useState('');
  const [importErr, setImportErr] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  async function onImport() {
    setImportErr(null);
    setImporting(true);
    try {
      await importByOwner(ownerInput);
      setOwnerInput('');
    } catch (e) {
      setImportErr(e instanceof Error ? e.message : 'Import failed.');
    } finally {
      setImporting(false);
    }
  }

  async function onClaim(owner: string) {
    reset();
    await runClaim(owner);
    refresh();
  }

  return (
    <div style={{ minHeight: '100vh', background: COLORS.bg, color: COLORS.text }}>
      <nav
        className="dmv-nav"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          padding: '0 24px',
          height: 64,
          borderBottom: `1px solid ${COLORS.border}`,
          position: 'sticky',
          top: 0,
          background: 'rgba(7,9,15,0.85)',
          backdropFilter: 'blur(10px)',
          zIndex: 10,
        }}
      >
        <div
          className="dmv-brand"
          style={{ display: 'flex', alignItems: 'center', gap: 10, fontWeight: 700, whiteSpace: 'nowrap', minWidth: 0 }}
        >
          <img src="/icon.png" alt="" width={26} height={26} style={{ borderRadius: 7, flexShrink: 0 }} />
          Dead Man's Vault
          <span
            className="dmv-net-badge"
            style={{
              marginLeft: 8,
              fontSize: 10.5,
              color: COLORS.accent,
              border: `1px solid ${COLORS.accent}`,
              borderRadius: 999,
              padding: '2px 8px',
              fontWeight: 600,
              flexShrink: 0,
            }}
          >
            {networkLabel()}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            onClick={() => setShowSettings(true)}
            title="Network settings"
            style={{
              background: 'transparent',
              border: `1px solid ${COLORS.border}`,
              borderRadius: 8,
              color: COLORS.textDim,
              width: 40,
              height: 40,
              fontSize: 17,
              cursor: 'pointer',
            }}
          >
            ⚙
          </button>
          <WalletMultiButton />
        </div>
      </nav>
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      <main style={{ maxWidth: 640, margin: '0 auto', padding: '40px 20px 80px' }}>
        <h1 style={{ fontSize: 30, fontWeight: 700, margin: '0 0 8px' }}>Claim your inheritance</h1>
        <p style={{ color: COLORS.textDim, fontSize: 14.5, lineHeight: 1.6, margin: '0 0 32px' }}>
          If someone left you crypto in a Dead Man's Vault, connect your wallet to see it here. When the
          owner stops checking in and the grace period elapses, you can distribute the estate yourself —
          the on-chain program sends every beneficiary exactly their pre-set share. You pay only network fees.
        </p>

        {!connected && (
          <div
            style={{
              background: COLORS.surface,
              border: `1px solid ${COLORS.border}`,
              borderRadius: 12,
              padding: 32,
              textAlign: 'center',
            }}
          >
            <p style={{ color: COLORS.textDim, margin: '0 0 18px' }}>Connect a wallet to get started.</p>
            <WalletMultiButton />
          </div>
        )}

        {connected && (
          <>
            {/* Claim progress / result banner */}
            {(claim.running || claim.done || claim.error) && (
              <div
                style={{
                  background: COLORS.surface,
                  border: `1px solid ${claim.error ? COLORS.critical : COLORS.accent}`,
                  borderRadius: 12,
                  padding: '14px 18px',
                  marginBottom: 20,
                  fontSize: 13.5,
                }}
              >
                {claim.running && (
                  <span>
                    Distributing… {claim.step ? `“${claim.step}”` : ''}{' '}
                    {claim.total > 0 ? `(step ${claim.index + 1}/${claim.total})` : ''}
                  </span>
                )}
                {claim.done && <span style={{ color: COLORS.accent }}>Done — estate distributed in {claim.done.steps} step(s). ✅</span>}
                {claim.error && <span style={{ color: COLORS.critical }}>{claim.error}</span>}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0, color: COLORS.textDim }}>
                {loading ? 'Loading…' : `${items.length} inheritance${items.length === 1 ? '' : 's'}`}
              </h2>
              <button
                onClick={refresh}
                style={{
                  background: 'transparent',
                  color: COLORS.textDim,
                  border: `1px solid ${COLORS.border}`,
                  borderRadius: 8,
                  padding: '6px 14px',
                  fontSize: 12.5,
                  cursor: 'pointer',
                }}
              >
                Refresh
              </button>
            </div>

            {error && <p style={{ color: COLORS.warning, fontSize: 13 }}>{error}</p>}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {items.map((item) => (
                <InheritanceCard
                  key={item.owner}
                  item={item}
                  busy={claim.running}
                  onClaim={onClaim}
                />
              ))}
            </div>

            {!loading && items.length === 0 && (
              <p style={{ color: COLORS.textDim, fontSize: 13.5, marginTop: 8 }}>
                Nothing found automatically. If you know the owner's wallet address, import it below.
              </p>
            )}

            {/* Manual import */}
            <div
              style={{
                marginTop: 36,
                borderTop: `1px solid ${COLORS.border}`,
                paddingTop: 24,
              }}
            >
              <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 10px' }}>Import by owner address</h3>
              <p style={{ color: COLORS.textDim, fontSize: 12.5, margin: '0 0 12px', lineHeight: 1.5 }}>
                Vaults not registered for notifications won't auto-appear. Paste the owner's wallet address to
                check on-chain directly.
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  value={ownerInput}
                  onChange={(e) => setOwnerInput(e.target.value)}
                  placeholder="Owner wallet address"
                  style={{
                    flex: 1,
                    background: COLORS.bg,
                    border: `1px solid ${COLORS.border}`,
                    borderRadius: 8,
                    padding: '10px 12px',
                    color: COLORS.text,
                    fontSize: 13,
                    fontFamily: 'monospace',
                  }}
                />
                <button
                  onClick={onImport}
                  disabled={!ownerInput.trim() || importing}
                  style={{
                    background: COLORS.surfaceHi,
                    color: COLORS.text,
                    border: `1px solid ${COLORS.border}`,
                    borderRadius: 8,
                    padding: '10px 18px',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: ownerInput.trim() && !importing ? 'pointer' : 'not-allowed',
                  }}
                >
                  {importing ? '…' : 'Check'}
                </button>
              </div>
              {importErr && <p style={{ color: COLORS.warning, fontSize: 12.5, marginTop: 8 }}>{importErr}</p>}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
