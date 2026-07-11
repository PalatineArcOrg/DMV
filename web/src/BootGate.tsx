import { useCallback, useEffect, useState } from 'react';
import { AppWalletProvider } from './wallet/WalletContext';
import App from './App';
import { NetworkGate } from './components/NetworkGate';
import { verifyNetwork, useNetworkStore, type NetworkVerification } from './lib/core';

/**
 * Fail-closed network gate (mirrors the app's App.tsx). Verifies the RPC's genesis hash
 * against this build's expected cluster BEFORE mounting the app (and thus before the
 * wallet-adapter ConnectionProvider). MISMATCH hard-blocks; UNKNOWN (RPC unreachable)
 * offers retry or an explicit continue into a read-only session. VERIFIED mounts the app.
 */
export function BootGate() {
  const [verification, setVerification] = useState<NetworkVerification | null>(null);
  const [busy, setBusy] = useState(true);
  const [proceed, setProceed] = useState(false);

  const run = useCallback(async (allowUnknown: boolean) => {
    setBusy(true);
    const v = await verifyNetwork();
    useNetworkStore.getState().setVerification(v);
    setVerification(v);
    setBusy(false);
    if (v.state === 'VERIFIED' || (v.state === 'UNKNOWN' && allowUnknown)) {
      setProceed(true);
    }
  }, []);

  useEffect(() => {
    void run(false);
  }, [run]);

  if (proceed) {
    return (
      <AppWalletProvider>
        <App />
      </AppWalletProvider>
    );
  }

  return (
    <NetworkGate
      verification={verification}
      busy={busy}
      onRetry={() => void run(false)}
      onContinue={verification?.state === 'UNKNOWN' ? () => void run(true) : undefined}
    />
  );
}
