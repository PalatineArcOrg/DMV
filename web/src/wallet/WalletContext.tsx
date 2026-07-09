import { FC, ReactNode, useMemo } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { getRpcUrl } from '../lib/core';
import '@solana/wallet-adapter-react-ui/styles.css';

/**
 * Wallet + connection context. We pass an EMPTY adapter list: Phantom, Solflare,
 * Backpack and other modern wallets register via the Wallet Standard and are
 * auto-detected, so no per-wallet adapter packages are needed.
 */
export const AppWalletProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const endpoint = useMemo(() => getRpcUrl(), []);
  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={[]} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
};
