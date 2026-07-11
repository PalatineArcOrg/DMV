import { useCallback, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { ClaimService, isNetworkVerified } from '../lib/core';

export interface ClaimState {
  running: boolean;
  step: string | null;
  index: number;
  total: number;
  done: { steps: number } | null;
  error: string | null;
}

const IDLE: ClaimState = { running: false, step: null, index: 0, total: 0, done: null, error: null };

/**
 * Drives ClaimService.runClaim with the connected browser wallet as the signer
 * (and fee payer). ClaimService itself handles blockhash/send/confirm and is
 * idempotent + resumable via on-chain masks, so a failed run can just be retried.
 */
export function useClaim() {
  const { publicKey, signTransaction } = useWallet();
  const [state, setState] = useState<ClaimState>(IDLE);

  const claim = useCallback(
    async (ownerAddress: string) => {
      if (!publicKey || !signTransaction) {
        setState({ ...IDLE, error: 'Connect a wallet first.' });
        return;
      }
      // Fail-closed: no claim writes on an unverified network (web UNKNOWN "continue" path).
      if (!isNetworkVerified()) {
        setState({ ...IDLE, error: 'Network not verified — reload and verify the network before claiming.' });
        return;
      }
      let owner: PublicKey;
      try {
        owner = new PublicKey(ownerAddress);
      } catch {
        setState({ ...IDLE, error: 'Invalid owner address.' });
        return;
      }

      setState({ ...IDLE, running: true });
      try {
        const result = await ClaimService.runClaim(
          owner,
          publicKey,
          signTransaction,
          (label, index, total) =>
            setState((s) => ({ ...s, step: label, index, total })),
        );
        setState({ ...IDLE, done: result });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Claim failed.';
        setState({ ...IDLE, error: msg });
      }
    },
    [publicKey, signTransaction],
  );

  const reset = useCallback(() => setState(IDLE), []);
  return { state, claim, reset };
}
