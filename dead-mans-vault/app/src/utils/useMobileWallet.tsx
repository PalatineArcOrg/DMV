import { transact } from "@solana-mobile/mobile-wallet-adapter-protocol-web3js";
import { Account, useAuthorization } from "./useAuthorization";
import {
  Transaction,
  TransactionSignature,
  VersionedTransaction,
} from "@solana/web3.js";
import { useCallback, useMemo } from "react";
import { SignInPayload } from "@solana-mobile/mobile-wallet-adapter-protocol";
import { assertNetworkVerified } from "../store/useNetworkStore";

export function useMobileWallet() {
  const { authorizeSessionWithSignIn, authorizeSession, deauthorizeSession } =
    useAuthorization();

  const connect = useCallback(async (): Promise<Account> => {
    return await transact(async (wallet) => {
      return await authorizeSession(wallet);
    });
  }, [authorizeSession]);

  const signIn = useCallback(
    async (signInPayload: SignInPayload): Promise<Account> => {
      return await transact(async (wallet) => {
        return await authorizeSessionWithSignIn(wallet, signInPayload);
      });
    },
    [authorizeSessionWithSignIn]
  );

  const disconnect = useCallback(async (): Promise<void> => {
    await transact(async (wallet) => {
      await deauthorizeSession(wallet);
    });
  }, [deauthorizeSession]);

  const signTransaction = useCallback(
    async (
      transaction: Transaction | VersionedTransaction,
    ): Promise<Transaction | VersionedTransaction> => {
      // Fail-closed: never sign an on-chain tx on an unverified network (the UNKNOWN
      // "continue anyway" path). Connect/read is allowed; signing is not.
      assertNetworkVerified("Signing a transaction");
      return await transact(async (wallet) => {
        await authorizeSession(wallet);
        const signedTransactions = await wallet.signTransactions({
          transactions: [transaction],
        });
        return signedTransactions[0];
      });
    },
    [authorizeSession]
  );

  const signAndSendTransaction = useCallback(
    async (
      transaction: Transaction | VersionedTransaction,
      minContextSlot?: number,
    ): Promise<TransactionSignature> => {
      assertNetworkVerified("Signing a transaction");
      return await transact(async (wallet) => {
        await authorizeSession(wallet);
        const signatures = await wallet.signAndSendTransactions({
          transactions: [transaction],
          minContextSlot,
        });
        return signatures[0];
      });
    },
    [authorizeSession]
  );

  const signMessage = useCallback(
    async (message: Uint8Array): Promise<Uint8Array> => {
      return await transact(async (wallet) => {
        const authResult = await authorizeSession(wallet);
        const signedMessages = await wallet.signMessages({
          addresses: [authResult.address],
          payloads: [message],
        });
        return signedMessages[0];
      });
    },
    [authorizeSession]
  );

  return useMemo(
    () => ({
      connect,
      signIn,
      disconnect,
      signTransaction,
      signAndSendTransaction,
      signMessage,
    }),
    [connect, signIn, disconnect, signTransaction, signAndSendTransaction, signMessage]
  );
}
