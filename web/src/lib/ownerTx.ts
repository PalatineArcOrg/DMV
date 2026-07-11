import { Connection, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { assertNetworkVerified } from './core';

type Sign = (tx: Transaction | VersionedTransaction) => Promise<Transaction | VersionedTransaction>;

/**
 * Sign + send + confirm an owner transaction with the connected browser wallet
 * (owner is the fee payer). Mirrors ClaimService.signSend but for owner-signed
 * config/deposit/withdraw ixs. The Transaction comes pre-built from
 * VaultTransactionService (unsigned — built against a dummy provider wallet).
 */
export async function signSendOwnerTx(
  connection: Connection,
  tx: Transaction,
  owner: PublicKey,
  signTransaction: Sign,
): Promise<string> {
  // Fail-closed: never sign+send an owner tx on an unverified network (the web UNKNOWN
  // "continue anyway" path). MISMATCH is already hard-blocked at boot by BootGate.
  assertNetworkVerified('This owner action');
  tx.feePayer = owner;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  const signed = (await signTransaction(tx)) as Transaction;
  const sig = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  return sig;
}
