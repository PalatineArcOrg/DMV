export const PROGRAM_ID = 'GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb';
export const RPC_URL = process.env.EXPO_PUBLIC_RPC_URL || 'https://api.devnet.solana.com';
export const HELIUS_API_KEY = process.env.EXPO_PUBLIC_HELIUS_API_KEY || '';
export const HELIUS_API_BASE = 'https://api-devnet.helius.xyz/v0';

export const COLORS = {
  bg: '#1C1917',
  surface: '#292524',
  surfaceHover: '#3D3835',
  healthy: '#16A34A',
  warning: '#D97706',
  critical: '#DC2626',
  accent: '#7C3AED',
  accentLight: '#A78BFA',
  textPrimary: '#F5F5F4',
  textSecondary: '#A8A29E',
  textMuted: '#78716C',
  border: '#44403C',
  borderLight: '#57534E',
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
