import { create } from 'zustand';
import { getSetting, setSetting } from '../db/settingsRepo';

interface DemoState {
  isDemoMode: boolean;
  tapCount: number;
  setDemoMode: (enabled: boolean) => void;
  incrementTap: () => void;
  loadFromDb: () => Promise<void>;
}

export const useDemoStore = create<DemoState>((set, get) => ({
  isDemoMode: false,
  tapCount: 0,

  setDemoMode: (enabled: boolean) => {
    set({ isDemoMode: enabled, tapCount: 0 });
    setSetting('demo_mode', enabled ? '1' : '0').catch(() => {});
  },

  incrementTap: () => {
    const { tapCount, isDemoMode } = get();
    const next = tapCount + 1;
    if (next >= 5) {
      const newMode = !isDemoMode;
      set({ isDemoMode: newMode, tapCount: 0 });
      setSetting('demo_mode', newMode ? '1' : '0').catch(() => {});
    } else {
      set({ tapCount: next });
    }
  },

  loadFromDb: async () => {
    try {
      const val = await getSetting('demo_mode');
      if (val === '1') {
        set({ isDemoMode: true });
      }
    } catch {
      // Non-fatal
    }
  },
}));
