import { useMemo, useCallback } from 'react';
import { PublicKey } from '@solana/web3.js';
import { useAuthorization } from '../utils/useAuthorization';
import { useMobileWallet } from '../utils/useMobileWallet';

export function useWallet() {
  const { selectedAccount, isLoading } = useAuthorization();
  const { connect: mobileConnect, disconnect: mobileDisconnect, signAndSendTransaction, signMessage } = useMobileWallet();

  const publicKey = useMemo(
    () => selectedAccount?.publicKey ?? null,
    [selectedAccount],
  );

  const connected = useMemo(() => !!publicKey, [publicKey]);

  const connect = useCallback(async () => {
    await mobileConnect();
  }, [mobileConnect]);

  const disconnect = useCallback(async () => {
    await mobileDisconnect();
  }, [mobileDisconnect]);

  return {
    publicKey,
    connected,
    isLoading,
    connect,
    disconnect,
    signAndSendTransaction,
    signMessage,
    selectedAccount,
  };
}
