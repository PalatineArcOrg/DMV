import './polyfills';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppWalletProvider } from './wallet/WalletContext';
import { loadRpcOverride } from './lib/core';
import { getSetting } from './lib/settings';
import App from './App';
import './index.css';

// Load the user's custom-RPC override ONCE, before any Connection is created
// (mirrors the app's App.tsx bootstrap). "Restart to apply" = reload the page.
async function boot() {
  await loadRpcOverride(getSetting);
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AppWalletProvider>
        <App />
      </AppWalletProvider>
    </StrictMode>,
  );
}

boot();
