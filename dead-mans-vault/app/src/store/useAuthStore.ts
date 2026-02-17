import { create } from 'zustand';
import { getSetting, setSetting } from '../db/settingsRepo';

interface AuthStore {
  isAuthEnabled: boolean;
  isAuthenticated: boolean;
  setAuthEnabled: (enabled: boolean) => void;
  setAuthenticated: (authenticated: boolean) => void;
  loadFromDb: () => Promise<void>;
}

export const useAuthStore = create<AuthStore>((set) => ({
  isAuthEnabled: false,
  isAuthenticated: false,

  setAuthEnabled: (enabled: boolean) => {
    set({ isAuthEnabled: enabled });
    setSetting('auth_enabled', enabled ? '1' : '0').catch(() => {});
  },

  setAuthenticated: (authenticated: boolean) => {
    set({ isAuthenticated: authenticated });
  },

  loadFromDb: async () => {
    try {
      const val = await getSetting('auth_enabled');
      if (val === '1') {
        set({ isAuthEnabled: true });
      }
    } catch {
      // Non-fatal
    }
  },
}));
