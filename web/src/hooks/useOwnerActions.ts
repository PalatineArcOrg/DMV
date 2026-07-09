import { useCallback, useState } from 'react';
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { VaultTransactionService, AssetAssignment } from '../lib/core';
import { signSendOwnerTx } from '../lib/ownerTx';

export interface ActionState {
  busy: string | null; // label of the running action, or null
  error: string | null;
  lastSig: string | null;
}

const IDLE: ActionState = { busy: null, error: null, lastSig: null };

/** Owner-signed vault operations. `svc` + `refresh` come from useVault(). */
export function useOwnerActions(svc: VaultTransactionService, refresh: () => Promise<void>) {
  const { publicKey, signTransaction } = useWallet();
  const [state, setState] = useState<ActionState>(IDLE);

  const run = useCallback(
    async (
      label: string,
      build: (owner: PublicKey) => Promise<import('@solana/web3.js').Transaction>,
    ): Promise<boolean> => {
      if (!publicKey || !signTransaction) {
        setState({ ...IDLE, error: 'Connect your wallet first.' });
        return false;
      }
      setState({ busy: label, error: null, lastSig: null });
      try {
        const tx = await build(publicKey);
        const sig = await signSendOwnerTx(svc.getConnection(), tx, publicKey, signTransaction);
        setState({ busy: null, error: null, lastSig: sig });
        await refresh();
        return true;
      } catch (e) {
        setState({ busy: null, error: e instanceof Error ? e.message : 'Transaction failed.', lastSig: null });
        return false;
      }
    },
    [publicKey, signTransaction, svc, refresh],
  );

  const depositSol = useCallback(
    (amountSol: number) => run('Depositing SOL', (o) => svc.buildFundVaultTx(o, Math.round(amountSol * LAMPORTS_PER_SOL))),
    [run, svc],
  );
  const withdrawSol = useCallback(
    (amountSol: number) => run('Withdrawing SOL', (o) => svc.buildWithdrawSolTx(o, Math.round(amountSol * LAMPORTS_PER_SOL))),
    [run, svc],
  );
  const withdrawToken = useCallback(
    // exact string → new BN(string) in the builder (no >2^53 Number() precision loss)
    (mint: string, rawAmount: bigint) =>
      run('Withdrawing token', (o) => svc.buildWithdrawTokenTx(o, new PublicKey(mint), rawAmount.toString())),
    [run, svc],
  );
  const depositToken = useCallback(
    // exact bigint → createTransferCheckedInstruction accepts bigint (no precision loss)
    (mint: string, rawAmount: bigint) =>
      run('Depositing asset', (o) => svc.buildDepositTokenTx(o, new PublicKey(mint), rawAmount)),
    [run, svc],
  );
  const clearBequests = useCallback(() => run('Clearing bequests', (o) => svc.buildClearAssetPlanTx(o)), [run, svc]);
  const updateBeneficiaries = useCallback(
    (bens: { wallet: string; shareBps: number }[]) =>
      run('Updating beneficiaries', (o) =>
        svc.buildUpdateVaultTx(o, {
          beneficiaries: bens.map((b) => ({ wallet: new PublicKey(b.wallet), shareBps: b.shareBps })),
        }),
      ),
    [run, svc],
  );
  const saveBequests = useCallback(
    (assignments: AssetAssignment[], hasPlan: boolean) =>
      run('Saving bequests', (o) =>
        hasPlan ? svc.buildUpdateAssetPlanTx(o, assignments) : svc.buildSetAssetPlanTx(o, assignments),
      ),
    [run, svc],
  );
  const revoke = useCallback(() => run('Revoking vault', (o) => svc.buildRevokeVaultTx(o)), [run, svc]);
  const closeExecuted = useCallback(() => run('Closing vault', (o) => svc.buildCloseExecutedVaultTx(o)), [run, svc]);

  const reset = useCallback(() => setState(IDLE), []);
  return {
    state,
    depositSol,
    withdrawSol,
    withdrawToken,
    depositToken,
    clearBequests,
    updateBeneficiaries,
    saveBequests,
    revoke,
    closeExecuted,
    reset,
  };
}
