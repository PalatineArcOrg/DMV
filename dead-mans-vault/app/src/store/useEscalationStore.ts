import { create } from 'zustand';
import { EscalationStage, EscalationState } from '../types';

interface EscalationStore {
  state: EscalationState;
  setStage: (stage: EscalationStage) => void;
  setExecutionDeadline: (deadline: number) => void;
  recordNotification: () => void;
  reset: () => void;
}

const initialState: EscalationState = {
  stage: 0,
  stageEnteredAt: null,
  executionDeadline: null,
  lastNotificationAt: null,
};

export const useEscalationStore = create<EscalationStore>((set) => ({
  state: initialState,

  setStage: (stage) =>
    set({
      state: {
        stage,
        stageEnteredAt: Math.floor(Date.now() / 1000),
        executionDeadline: null,
        lastNotificationAt: null,
      },
    }),

  setExecutionDeadline: (deadline) =>
    set((prev) => ({
      state: { ...prev.state, executionDeadline: deadline },
    })),

  recordNotification: () =>
    set((prev) => ({
      state: {
        ...prev.state,
        lastNotificationAt: Math.floor(Date.now() / 1000),
      },
    })),

  reset: () => set({ state: initialState }),
}));
