import { create } from 'zustand';
import { HeartbeatStatus, HeartbeatConfig } from '../types';

interface HeartbeatStore {
  status: HeartbeatStatus | null;
  config: HeartbeatConfig | null;
  isLoading: boolean;
  setStatus: (status: HeartbeatStatus | null) => void;
  setConfig: (config: HeartbeatConfig | null) => void;
  setLoading: (loading: boolean) => void;
  reset: () => void;
}

export const useHeartbeatStore = create<HeartbeatStore>((set) => ({
  status: null,
  config: null,
  isLoading: false,
  setStatus: (status) => set({ status }),
  setConfig: (config) => set({ config }),
  setLoading: (loading) => set({ isLoading: loading }),
  reset: () => set({ status: null, config: null, isLoading: false }),
}));
