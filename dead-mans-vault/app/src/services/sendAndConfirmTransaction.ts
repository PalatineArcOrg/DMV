export interface BlockhashValidity {
  blockhash: string;
  lastValidBlockHeight: number;
}

export interface SignableTransaction<PublicKeyType, SignerType> {
  feePayer?: PublicKeyType;
  recentBlockhash?: string;
  sign: (...signers: Array<SignerType>) => void;
  serialize: () => Uint8Array;
}

export interface TransactionPayer<PublicKeyType> {
  publicKey: PublicKeyType;
}

export interface SendAndConfirmDependencies {
  getLatestBlockhash: () => Promise<BlockhashValidity>;
  sendRawTransaction: (serializedTransaction: Uint8Array) => Promise<string>;
  confirmTransaction: (
    strategy: BlockhashValidity & { signature: string },
  ) => Promise<unknown>;
}

export async function signSendAndConfirmTransaction<
  PublicKeyType,
  SignerType,
>(
  transaction: SignableTransaction<PublicKeyType, SignerType>,
  payer: SignerType & TransactionPayer<PublicKeyType>,
  extraSigners: Array<SignerType>,
  dependencies: SendAndConfirmDependencies,
): Promise<string> {
  transaction.feePayer = payer.publicKey;
  const { blockhash, lastValidBlockHeight } =
    await dependencies.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.sign(payer, ...extraSigners);

  const signature = await dependencies.sendRawTransaction(
    transaction.serialize(),
  );
  await dependencies.confirmTransaction({
    signature,
    blockhash,
    lastValidBlockHeight,
  });
  return signature;
}
