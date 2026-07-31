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

export interface PreparedTransaction {
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

export type SubmissionUnknownCode =
  | 'send_exception'
  | 'empty_rpc_signature'
  | 'rpc_signature_mismatch';

export interface SendAndConfirmLifecycle {
  onPrepared: (prepared: PreparedTransaction) => Promise<void>;
  onSubmitted?: (prepared: PreparedTransaction) => Promise<void>;
  onSubmissionUnknown?: (
    prepared: PreparedTransaction,
    code: SubmissionUnknownCode,
  ) => Promise<void>;
  onConfirmationUnknown?: (
    prepared: PreparedTransaction,
    code: 'confirmation_exception' | 'confirmation_malformed',
  ) => Promise<void>;
  onConfirmedFailed?: (
    prepared: PreparedTransaction,
  ) => Promise<void>;
}

export interface SendAndConfirmDependencies<
  PublicKeyType,
  SignerType,
  TransactionType extends SignableTransaction<PublicKeyType, SignerType>,
> {
  getLatestBlockhash: () => Promise<BlockhashValidity>;
  deriveExpectedSignature: (
    transaction: TransactionType,
    payer: SignerType & TransactionPayer<PublicKeyType>,
  ) => string;
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
      status: 'submission_unknown';
      signature: string;
      error: unknown;
      safeErrorCode: SubmissionUnknownCode;
      rpcSignature?: string;
    }
  | {
      status: 'journal_failed';
      error: unknown;
    }
  | {
      status: 'preparation_failed';
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

async function runPostSendLifecycle(
  callback: (() => Promise<void>) | undefined,
): Promise<void> {
  try {
    await callback?.();
  } catch {
    // PREPARED is already durable. A later reconciliation can recover even if
    // a more-specific post-send journal transition could not be written.
  }
}

export async function signSendAndConfirmTransaction<
  PublicKeyType,
  SignerType,
  TransactionType extends SignableTransaction<PublicKeyType, SignerType>,
>(
  transaction: TransactionType,
  payer: SignerType & TransactionPayer<PublicKeyType>,
  extraSigners: Array<SignerType>,
  dependencies: SendAndConfirmDependencies<
    PublicKeyType,
    SignerType,
    TransactionType
  >,
  lifecycle: SendAndConfirmLifecycle,
): Promise<SendAndConfirmResult> {
  let prepared: PreparedTransaction;
  let serializedTransaction: Uint8Array;

  try {
    transaction.feePayer = payer.publicKey;
    const blockhashValidity = await dependencies.getLatestBlockhash();
    transaction.recentBlockhash = blockhashValidity.blockhash;
    transaction.sign(payer, ...extraSigners);
    const signature = dependencies.deriveExpectedSignature(
      transaction,
      payer,
    );
    if (!signature) {
      throw new Error('Expected payer signature is unavailable');
    }
    serializedTransaction = transaction.serialize();
    prepared = {
      signature,
      ...blockhashValidity,
    };
  } catch (error: unknown) {
    return { status: 'preparation_failed', error };
  }

  try {
    await lifecycle.onPrepared(prepared);
  } catch (error: unknown) {
    return { status: 'journal_failed', error };
  }

  let rpcSignature: string;
  try {
    rpcSignature = await dependencies.sendRawTransaction(
      serializedTransaction,
    );
  } catch (error: unknown) {
    await runPostSendLifecycle(() =>
      lifecycle.onSubmissionUnknown?.(
        prepared,
        'send_exception',
      ) ?? Promise.resolve(),
    );
    return {
      status: 'submission_unknown',
      signature: prepared.signature,
      error,
      safeErrorCode: 'send_exception',
    };
  }

  if (!rpcSignature) {
    const error = new Error('RPC submission returned no signature');
    await runPostSendLifecycle(() =>
      lifecycle.onSubmissionUnknown?.(
        prepared,
        'empty_rpc_signature',
      ) ?? Promise.resolve(),
    );
    return {
      status: 'submission_unknown',
      signature: prepared.signature,
      error,
      safeErrorCode: 'empty_rpc_signature',
    };
  }

  if (rpcSignature !== prepared.signature) {
    const error = new Error('RPC signature did not match the signed transaction');
    await runPostSendLifecycle(() =>
      lifecycle.onSubmissionUnknown?.(
        prepared,
        'rpc_signature_mismatch',
      ) ?? Promise.resolve(),
    );
    return {
      status: 'submission_unknown',
      signature: prepared.signature,
      error,
      safeErrorCode: 'rpc_signature_mismatch',
      rpcSignature,
    };
  }

  await runPostSendLifecycle(() =>
    lifecycle.onSubmitted?.(prepared) ?? Promise.resolve(),
  );

  try {
    const confirmation = await dependencies.confirmTransaction({
      signature: prepared.signature,
      blockhash: prepared.blockhash,
      lastValidBlockHeight: prepared.lastValidBlockHeight,
    });
    const result = classifyConfirmation(
      prepared.signature,
      confirmation,
    );
    if (result.status === 'confirmed_failed') {
      await runPostSendLifecycle(() =>
        lifecycle.onConfirmedFailed?.(prepared) ?? Promise.resolve(),
      );
    } else if (result.status === 'confirmation_unknown') {
      await runPostSendLifecycle(() =>
        lifecycle.onConfirmationUnknown?.(
          prepared,
          'confirmation_malformed',
        ) ?? Promise.resolve(),
      );
    }
    return result;
  } catch (error: unknown) {
    await runPostSendLifecycle(() =>
      lifecycle.onConfirmationUnknown?.(
        prepared,
        'confirmation_exception',
      ) ?? Promise.resolve(),
    );
    return {
      status: 'confirmation_unknown',
      signature: prepared.signature,
      error,
    };
  }
}
