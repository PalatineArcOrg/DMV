import { PublicKey } from '@solana/web3.js';

export function isValidPublicKey(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

export function validateBeneficiaryShares(shares: number[]): boolean {
  if (shares.length === 0 || shares.length > 20) return false;
  const sum = shares.reduce((a, b) => a + b, 0);
  return sum === 10000;
}
