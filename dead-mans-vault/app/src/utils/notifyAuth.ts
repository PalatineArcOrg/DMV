// Canonical signed-message format for notify-server registration/deregistration.
// MUST stay byte-for-byte identical to notify-server/src/authMessage.js.

export const REGISTER_DOMAIN = 'DMV_NOTIFY_REGISTER_V1';
export const DEREGISTER_DOMAIN = 'DMV_NOTIFY_DEREGISTER_V1';

export interface RegisterFields {
  owner: string;
  vault: string;
  deviceTokenHash: string; // sha256(deviceToken), lowercase hex
  stage1: number;
  stage2: number;
  stage3: number;
  timestamp: number; // unix seconds
  nonce: string;
}

export function registerMessage(f: RegisterFields): string {
  return [
    REGISTER_DOMAIN,
    `owner=${f.owner}`,
    `vault=${f.vault}`,
    `deviceTokenHash=${f.deviceTokenHash}`,
    `stage1=${f.stage1}`,
    `stage2=${f.stage2}`,
    `stage3=${f.stage3}`,
    `timestamp=${f.timestamp}`,
    `nonce=${f.nonce}`,
  ].join('\n');
}

export interface DeregisterFields {
  owner: string;
  vault: string;
  timestamp: number;
  nonce: string;
}

export function deregisterMessage(f: DeregisterFields): string {
  return [
    DEREGISTER_DOMAIN,
    `owner=${f.owner}`,
    `vault=${f.vault}`,
    `timestamp=${f.timestamp}`,
    `nonce=${f.nonce}`,
  ].join('\n');
}
