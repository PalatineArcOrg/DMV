import { Keypair, Transaction } from '@solana/web3.js';
import * as SecureStore from 'expo-secure-store';
import bs58 from 'bs58';

const SECRET_KEY = 'dmv_agent_secret_key';
const PUBLIC_KEY = 'dmv_agent_public_key';
const PRESIGNED_TX_KEY = 'dmv_presigned_distribution_tx';
const NONCE_ACCOUNT_KEY = 'dmv_nonce_account';
const DISTRIBUTION_AMOUNT_KEY = 'dmv_distribution_amount';

export class KeyManager {
  private static instance: KeyManager | null = null;
  private cachedKeypair: Keypair | null = null;

  static getInstance(): KeyManager {
    if (!KeyManager.instance) {
      KeyManager.instance = new KeyManager();
    }
    return KeyManager.instance;
  }

  async generateAgentKey(): Promise<string> {
    const keypair = Keypair.generate();
    const secretB58 = bs58.encode(keypair.secretKey);
    const publicB58 = keypair.publicKey.toBase58();

    await SecureStore.setItemAsync(SECRET_KEY, secretB58, {
      requireAuthentication: false,
    });
    await SecureStore.setItemAsync(PUBLIC_KEY, publicB58, {
      requireAuthentication: false,
    });

    this.cachedKeypair = keypair;
    return publicB58;
  }

  async getAgentPublicKey(): Promise<string | null> {
    return SecureStore.getItemAsync(PUBLIC_KEY);
  }

  async hasAgentKey(): Promise<boolean> {
    const pk = await SecureStore.getItemAsync(PUBLIC_KEY);
    return pk !== null;
  }

  async getKeypair(): Promise<Keypair> {
    if (this.cachedKeypair) return this.cachedKeypair;

    const secretB58 = await SecureStore.getItemAsync(SECRET_KEY);
    if (!secretB58) {
      throw new Error('No agent key found in secure store');
    }

    const secretKey = bs58.decode(secretB58);
    this.cachedKeypair = Keypair.fromSecretKey(secretKey);
    return this.cachedKeypair;
  }

  async signTransaction(tx: Transaction): Promise<Transaction> {
    const keypair = await this.getKeypair();
    tx.partialSign(keypair);
    return tx;
  }

  async destroyKey(): Promise<void> {
    await SecureStore.deleteItemAsync(SECRET_KEY);
    await SecureStore.deleteItemAsync(PUBLIC_KEY);
    await SecureStore.deleteItemAsync(PRESIGNED_TX_KEY);
    await SecureStore.deleteItemAsync(NONCE_ACCOUNT_KEY);
    await SecureStore.deleteItemAsync(DISTRIBUTION_AMOUNT_KEY);
    this.cachedKeypair = null;
  }

  async storePresignedTx(base64Tx: string): Promise<void> {
    await SecureStore.setItemAsync(PRESIGNED_TX_KEY, base64Tx, {
      requireAuthentication: false,
    });
  }

  async getPresignedTx(): Promise<string | null> {
    return SecureStore.getItemAsync(PRESIGNED_TX_KEY);
  }

  async clearPresignedTx(): Promise<void> {
    await SecureStore.deleteItemAsync(PRESIGNED_TX_KEY);
  }

  async storeNonceAccount(pubkey: string): Promise<void> {
    await SecureStore.setItemAsync(NONCE_ACCOUNT_KEY, pubkey, {
      requireAuthentication: false,
    });
  }

  async getNonceAccount(): Promise<string | null> {
    return SecureStore.getItemAsync(NONCE_ACCOUNT_KEY);
  }

  async clearNonceAccount(): Promise<void> {
    await SecureStore.deleteItemAsync(NONCE_ACCOUNT_KEY);
  }

  async storeDistributionAmount(lamports: string): Promise<void> {
    await SecureStore.setItemAsync(DISTRIBUTION_AMOUNT_KEY, lamports, {
      requireAuthentication: false,
    });
  }

  async getDistributionAmount(): Promise<string | null> {
    return SecureStore.getItemAsync(DISTRIBUTION_AMOUNT_KEY);
  }

  async clearDistributionAmount(): Promise<void> {
    await SecureStore.deleteItemAsync(DISTRIBUTION_AMOUNT_KEY);
  }
}
