import { Platform } from 'react-native';

export const PROGRAM_ID = 'GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb';

/** Recipient of the on-chain 0.01 SOL vault-creation fee. Pinned on-chain by
 *  `initialize_vault` (address = FEE_WALLET @ InvalidFeeRecipient). Passed
 *  explicitly by the app rather than relying on Anchor IDL auto-resolution. */
export const FEE_WALLET = '98x9Rn63Ne8xbL3w522zgbuYg9bdHn7cRqJQVCUZUFsp';
// RPC URL + Helius endpoints/key now live in ./rpcConfig (runtime-overridable via the
// Settings → NETWORK custom-RPC field). Import the getters from there, not constants.

/** The Solana cluster this build is meant to run against. Sourced from the build-time
 *  EXPO_PUBLIC_EXPECTED_CLUSTER (set per EAS profile). Defaults to 'devnet' for the
 *  current devnet-only phase; a mainnet build must set it to 'mainnet-beta'. The network
 *  gate (rpcConfig.verifyNetwork) checks the live RPC's genesis hash against
 *  EXPECTED_GENESIS_HASH and fails closed on mismatch — so an accidental wrong-cluster
 *  RPC cannot silently connect. */
export const EXPECTED_CLUSTER: 'devnet' | 'mainnet-beta' =
  process.env.EXPO_PUBLIC_EXPECTED_CLUSTER === 'mainnet-beta' ? 'mainnet-beta' : 'devnet';

/** Canonical Solana genesis hashes per cluster — the ground truth used to verify which
 *  network an RPC is actually serving (never inferred from the URL string). */
export const GENESIS_HASHES = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
} as const;

/** The genesis hash the live RPC must return for this build to proceed. */
export const EXPECTED_GENESIS_HASH = GENESIS_HASHES[EXPECTED_CLUSTER];

// DMV push-notification server (FCM relay). Empty = push registration disabled.
export const NOTIFY_URL = process.env.EXPO_PUBLIC_NOTIFY_URL || '';

/** Keeper bounty (0.005 SOL) reserved in the vault at creation, paid to whoever
 *  cranks finalize_execution. Carved out on-chain so it never reduces payouts. */
export const KEEPER_BOUNTY_LAMPORTS = 5_000_000;

/** Upper bound on the keeper bounty (0.1 SOL). MUST match the on-chain
 *  `MAX_KEEPER_BOUNTY_LAMPORTS` guard (VaultError::KeeperBountyTooLarge). A bounty
 *  above this is rejected by the program; validate client-side first for a clear
 *  error instead of a raw on-chain failure. */
export const MAX_KEEPER_BOUNTY_LAMPORTS = 100_000_000;
export const NOTIFY_SECRET = process.env.EXPO_PUBLIC_NOTIFY_SECRET || '';

export const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6';
export const JUPITER_SWAP_API = 'https://quote-api.jup.ag/v6/swap';

export const COLORS = {
  bg: '#07090F',
  surface: '#0F1521',
  surfaceHover: '#141B2D',
  healthy: '#00FFA3',
  warning: '#F59E0B',
  critical: '#EF4444',
  accent: '#00FFA3',
  accentLight: '#00FFA3',
  textPrimary: '#FFFFFF',
  textSecondary: 'rgba(255,255,255,0.55)',
  textMuted: 'rgba(255,255,255,0.35)',
  textDim: 'rgba(255,255,255,0.25)',
  border: 'rgba(255,255,255,0.07)',
  borderLight: 'rgba(255,255,255,0.06)',
  solanaPurple: '#9945FF',
  blueAccent: '#4DA6FF',
};

export const FONTS = {
  primary: 'SpaceGrotesk_400Regular',
  primaryMedium: 'SpaceGrotesk_500Medium',
  primarySemiBold: 'SpaceGrotesk_600SemiBold',
  primaryBold: 'SpaceGrotesk_700Bold',
  mono: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
};

export const SPACING = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
};

export const HEARTBEAT_INTERVALS = {
  daily: 86400,
  weekly: 604800,
  biweekly: 1209600,
  monthly: 2592000,
};

export const GRACE_PERIOD_DEFAULTS = {
  minimum: 604800,
  recommended: 2073600,
  maximum: 7776000,
};

export const ESCALATION_DEFAULTS = {
  stage1: 259200,
  stage2: 604800,
  stage3: 604800,
};

export const STAGE_CONFIG: Record<number, {
  color: string;
  dimColor: string;
  borderColor: string;
  glowColor: string;
  label: string;
  sublabel: string;
  buttonLabel: string;
  buttonActive: boolean;
  icon: string;
  urgency: number;
}> = {
  0: {
    color: '#00FFA3',
    dimColor: 'rgba(0,255,163,0.15)',
    borderColor: 'rgba(0,255,163,0.25)',
    glowColor: 'rgba(0,255,163,0.3)',
    label: 'Vault Active',
    sublabel: 'All systems normal',
    buttonLabel: 'Heartbeat Confirmed',
    buttonActive: true,
    icon: 'pulse',
    urgency: 0,
  },
  1: {
    color: '#F59E0B',
    dimColor: 'rgba(245,158,11,0.12)',
    borderColor: 'rgba(245,158,11,0.3)',
    glowColor: 'rgba(245,158,11,0.3)',
    label: 'Heartbeat Overdue',
    sublabel: 'Reminder notification sent',
    buttonLabel: 'Confirm Heartbeat',
    buttonActive: true,
    icon: 'clock-outline',
    urgency: 1,
  },
  2: {
    color: '#F97316',
    dimColor: 'rgba(249,115,22,0.12)',
    borderColor: 'rgba(249,115,22,0.35)',
    glowColor: 'rgba(249,115,22,0.35)',
    label: 'Emergency Alert',
    sublabel: 'Escalation alert sent',
    buttonLabel: 'Confirm NOW',
    buttonActive: true,
    icon: 'alert',
    urgency: 2,
  },
  3: {
    color: '#EF4444',
    dimColor: 'rgba(239,68,68,0.12)',
    borderColor: 'rgba(239,68,68,0.4)',
    glowColor: 'rgba(239,68,68,0.4)',
    label: 'Final Warning',
    sublabel: 'Final warning — execution imminent',
    buttonLabel: 'CONFIRM IMMEDIATELY',
    buttonActive: true,
    icon: 'alert-octagon',
    urgency: 3,
  },
  4: {
    color: '#DC2626',
    dimColor: 'rgba(220,38,38,0.15)',
    borderColor: 'rgba(220,38,38,0.5)',
    glowColor: 'rgba(220,38,38,0.5)',
    label: 'Distributing Assets',
    sublabel: 'Vault execution in progress\u2026',
    buttonLabel: 'View Execution Log',
    buttonActive: false,
    icon: 'flash',
    urgency: 4,
  },
};

export const INTERVAL_CONFIG = {
  weekly: { label: 'Weekly', days: 7, grace: '3 days', description: 'Check in every 7 days' },
  biweekly: { label: 'Bi-Weekly', days: 14, grace: '7 days', description: 'Check in every 14 days' },
  monthly: { label: 'Monthly', days: 30, grace: '14 days', description: 'Check in every 30 days' },
} as const;

export const TOKEN_COLORS: Record<string, string> = {
  SOL: '#9945FF',
  USDC: '#2775CA',
  JUP: '#C7F284',
  BONK: '#F5841E',
  RAY: '#4DA6FF',
  USDT: '#26A17B',
  MSOL: '#9BE1DA',
  JSOL: '#00D4B4',
};

// Mint address → logo CDN URL for common Solana tokens
export const KNOWN_TOKEN_LOGOS: Record<string, string> = {
  // Native SOL (PublicKey.default)
  '11111111111111111111111111111111': 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
  // Wrapped SOL
  'So11111111111111111111111111111111111111112': 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
  // USDC
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png',
  // USDT
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.svg',
  // mSOL (Marinade)
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So': 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So/logo.png',
  // jitoSOL
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn': 'https://storage.googleapis.com/token-metadata/JitoSOL-256.png',
  // JUP
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': 'https://static.jup.ag/jup/icon.png',
  // BONK
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 'https://arweave.net/hQiPZOsRZXGXBJd_82PhVdlM_hACsT_q6wqwf5cSY7I',
  // RAY (Raydium)
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R': 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R/logo.png',
  // ORCA
  'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE': 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE/logo.png',
  // bSOL (SolBlaze)
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1': 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1/logo.png',
};
