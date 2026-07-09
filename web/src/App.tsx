import { useState } from 'react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { SettingsModal } from './components/SettingsModal';
import { InheritancesView } from './views/InheritancesView';
import { MyVaultView } from './views/MyVaultView';
import { COLORS } from './lib/theme';
import { networkLabel } from './lib/core';

type Tab = 'inheritances' | 'vault';

export default function App() {
  // Land on My Vault by default (most people manage their own vault); the claim
  // tab is deep-linkable via #inheritances.
  const [tab, setTabState] = useState<Tab>(
    typeof location !== 'undefined' && location.hash === '#inheritances' ? 'inheritances' : 'vault',
  );
  const setTab = (t: Tab) => {
    setTabState(t);
    if (typeof history !== 'undefined') history.replaceState(null, '', t === 'inheritances' ? '#inheritances' : '#');
  };
  const [showSettings, setShowSettings] = useState(false);

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

      {/* Tab switcher */}
      <div style={{ display: 'flex', justifyContent: 'center', gap: 6, padding: '18px 20px 0' }}>
        <div
          style={{
            display: 'inline-flex',
            background: COLORS.surface,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 10,
            padding: 4,
          }}
        >
          <TabButton active={tab === 'inheritances'} onClick={() => setTab('inheritances')}>
            Inheritances
          </TabButton>
          <TabButton active={tab === 'vault'} onClick={() => setTab('vault')}>
            My Vault
          </TabButton>
        </div>
      </div>

      <main style={{ maxWidth: 640, margin: '0 auto', padding: '24px 20px 80px' }}>
        {tab === 'inheritances' ? <InheritancesView /> : <MyVaultView />}
      </main>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? COLORS.accent : 'transparent',
        color: active ? '#04120B' : COLORS.textDim,
        border: 'none',
        borderRadius: 7,
        padding: '8px 18px',
        fontSize: 13,
        fontWeight: 700,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}
