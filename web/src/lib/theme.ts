// DMV design system (matches the mobile app + website).
export const COLORS = {
  bg: '#07090F',
  surface: '#0F1521',
  surfaceHi: '#151C2B',
  border: 'rgba(255,255,255,0.10)',
  text: '#F2F2F0',
  textDim: '#8A93A6',
  accent: '#00FFA3',
  warning: '#F59E0B',
  critical: '#EF4444',
};

export const STATUS_META: Record<
  string,
  { label: string; color: string; hint: string }
> = {
  active: { label: 'Active', color: COLORS.textDim, hint: 'The owner is alive and checking in. Nothing to claim yet.' },
  warning: { label: 'Overdue', color: COLORS.warning, hint: 'The owner has missed check-ins. Claim opens when the grace period elapses.' },
  claimable: { label: 'Claimable', color: COLORS.accent, hint: 'Grace elapsed — you can distribute this estate now.' },
  executed: { label: 'Distributed', color: COLORS.textDim, hint: 'This estate has already been distributed.' },
};
