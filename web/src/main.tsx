import './polyfills';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { loadRpcOverride } from './lib/core';
import { getSetting } from './lib/settings';
import { BootGate } from './BootGate';
import './index.css';

// Load the user's custom-RPC override ONCE, before any Connection is created
// (mirrors the app's App.tsx bootstrap). "Restart to apply" = reload the page.
// BootGate then verifies the network (fail-closed) before mounting the app.
async function boot() {
  await loadRpcOverride(getSetting);
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <BootGate />
    </StrictMode>,
  );
}

boot();
