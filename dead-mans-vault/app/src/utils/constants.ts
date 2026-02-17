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
    buttonActive: false,
    icon: 'shield-check',
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
    sublabel: 'Beneficiaries have been notified',
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
    sublabel: '< 24 hours until execution',
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
