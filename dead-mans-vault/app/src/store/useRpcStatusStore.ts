import { create } from 'zustand';

/**
 * Tracks when the app last hit an RPC/DAS/API rate-limit (HTTP 429 or a JSON-RPC 429),
 * so the UI can surface a "network busy" hint that nudges the user toward setting their
 * own RPC in Settings → Network. Written from the fetch layer (outside React).
 */
interface RpcStatusState {
  lastRateLimitAt: number | null;
  reportRateLimited: () => void;
}

export const useRpcStatusStore = create<RpcStatusState>((set) => ({
  lastRateLimitAt: null,
  reportRateLimited: () => set({ lastRateLimitAt: Date.now() }),
}));
