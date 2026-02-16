import { Platform } from 'react-native';

export const PROGRAM_ID = 'GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb';
export const RPC_URL = process.env.EXPO_PUBLIC_RPC_URL || 'https://api.devnet.solana.com';
export const HELIUS_API_KEY = process.env.EXPO_PUBLIC_HELIUS_API_KEY || '';
export const HELIUS_API_BASE = 'https://api-devnet.helius.xyz/v0';
export const HELIUS_ENHANCED_API = 'https://api-devnet.helius-rpc.com/v0';
export const HELIUS_PARSE_TX_API = 'https://api-devnet.helius-rpc.com/v0/transactions';
export const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6';
export const JUPITER_SWAP_API = 'https://quote-api.jup.ag/v6/swap';

export const COLORS = {
  bg: '#080A0F',
  surface: '#12162D',
  surfaceHover: '#1A1F3D',
  healthy: '#00D4B4',
  warning: '#FFB932',
  critical: '#FF4D4D',
  accent: '#00D4B4',
  accentLight: '#33DFCA',
  textPrimary: '#FFFFFF',
  textSecondary: '#B4B9C3',
  textMuted: '#505564',
  border: '#1A1F3D',
  borderLight: '#252A45',
};

export const FONTS = {
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
