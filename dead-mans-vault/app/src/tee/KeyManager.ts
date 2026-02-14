import { Keypair, Transaction } from '@solana/web3.js';
import * as SecureStore from 'expo-secure-store';
import bs58 from 'bs58';

const SECRET_KEY = 'dmv_agent_secret_key';
const PUBLIC_KEY = 'dmv_agent_public_key';

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
    this.cachedKeypair = null;
  }
}
