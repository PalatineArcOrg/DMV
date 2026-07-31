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

export type SendAndConfirmResult =
  | {
      status: 'confirmed';
      signature: string;
    }
  | {
      status: 'confirmed_failed';
      signature: string;
      transactionError: unknown;
    }
  | {
      status: 'confirmation_unknown';
      signature: string;
      error: unknown;
    }
  | {
      status: 'submission_failed';
      error: unknown;
    };

function malformedConfirmationError(): Error {
  return new Error('Malformed transaction confirmation response');
}

function classifyConfirmation(
  signature: string,
  response: unknown,
): SendAndConfirmResult {
  if (!response || typeof response !== 'object') {
    return {
      status: 'confirmation_unknown',
      signature,
      error: malformedConfirmationError(),
    };
  }

  const value = Reflect.get(response, 'value');
  if (!value || typeof value !== 'object') {
    return {
      status: 'confirmation_unknown',
      signature,
      error: malformedConfirmationError(),
    };
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'err')) {
    return {
      status: 'confirmation_unknown',
      signature,
      error: malformedConfirmationError(),
    };
  }

  const transactionError = Reflect.get(value, 'err');
  if (transactionError === null) {
    return { status: 'confirmed', signature };
  }
  if (transactionError === undefined) {
    return {
      status: 'confirmation_unknown',
      signature,
      error: malformedConfirmationError(),
    };
  }
  return {
    status: 'confirmed_failed',
    signature,
    transactionError,
  };
}

export async function signSendAndConfirmTransaction<
  PublicKeyType,
  SignerType,
>(
  transaction: SignableTransaction<PublicKeyType, SignerType>,
  payer: SignerType & TransactionPayer<PublicKeyType>,
  extraSigners: Array<SignerType>,
  dependencies: SendAndConfirmDependencies,
): Promise<SendAndConfirmResult> {
  let signature: string;
  let blockhashValidity: BlockhashValidity;
  try {
    transaction.feePayer = payer.publicKey;
    blockhashValidity = await dependencies.getLatestBlockhash();
    transaction.recentBlockhash = blockhashValidity.blockhash;
    transaction.sign(payer, ...extraSigners);
    const serializedTransaction = transaction.serialize();
    signature = await dependencies.sendRawTransaction(
      serializedTransaction,
    );
    if (!signature) {
      return {
        status: 'submission_failed',
        error: new Error('Transaction submission returned no signature'),
      };
    }
  } catch (error: unknown) {
    return { status: 'submission_failed', error };
  }

  try {
    const confirmation = await dependencies.confirmTransaction({
      signature,
      ...blockhashValidity,
    });
    return classifyConfirmation(signature, confirmation);
  } catch (error: unknown) {
    return {
      status: 'confirmation_unknown',
      signature,
      error,
    };
  }
}
