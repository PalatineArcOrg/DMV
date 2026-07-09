import { useState } from 'react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { SettingsModal } from './components/SettingsModal';
import { InheritancesView } from './views/InheritancesView';
import { MyVaultView } from './views/MyVaultView';
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
    <div className="app">
      <header className="topbar">
        <div className="topbar-in">
          <div className="brand">
            <img src="/icon.png" alt="" width={26} height={26} />
            <span>Dead Man's Vault</span>
            <span className="net">{networkLabel()}</span>
          </div>

          <div className="tabs" role="tablist" aria-label="Sections">
            <button className="tab" role="tab" aria-selected={tab === 'vault'} onClick={() => setTab('vault')}>
              My Vault
            </button>
            <button className="tab" role="tab" aria-selected={tab === 'inheritances'} onClick={() => setTab('inheritances')}>
              Inheritances
            </button>
          </div>

          <div className="topbar-right">
            <button className="icon-btn" title="Network settings" onClick={() => setShowSettings(true)}>
              ⚙
            </button>
            <WalletMultiButton />
          </div>
        </div>
      </header>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      <main className="shell">{tab === 'vault' ? <MyVaultView /> : <InheritancesView />}</main>
    </div>
  );
}
