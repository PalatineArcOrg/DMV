import { create } from 'zustand';
import type { NetworkState, NetworkVerification } from '../utils/rpcConfig';

/**
 * Holds the result of the fail-closed genesis-hash network verification (rpcConfig.verifyNetwork),
 * written once at bootstrap (App.tsx). It is the single source of truth for "is the network
 * verified" — future write-gated call sites (MWA authorize, heartbeat, push registration) read
 * `isVerified()` so they no-op while the network is UNKNOWN. MISMATCH never reaches those sites:
 * it hard-blocks at boot before any Connection mounts.
 */
interface NetworkStoreState {
  state: NetworkState;
  expectedCluster: string;
  expectedGenesis: string;
  receivedGenesis: string | null;
  setVerification: (v: NetworkVerification) => void;
  isVerified: () => boolean;
}

export const useNetworkStore = create<NetworkStoreState>((set, get) => ({
  state: 'UNKNOWN',
  expectedCluster: '',
  expectedGenesis: '',
  receivedGenesis: null,
  setVerification: (v) =>
    set({
      state: v.state,
      expectedCluster: v.expectedCluster,
      expectedGenesis: v.expectedGenesis,
      receivedGenesis: v.receivedGenesis ?? null,
    }),
  isVerified: () => get().state === 'VERIFIED',
}));
