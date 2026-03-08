import { create } from 'zustand';
import { PublicKey } from '@solana/web3.js';
import {
  VaultConfig,
  Beneficiary,
  DeFiPosition,
  EscalationConfig,
} from '../types';
import { ESCALATION_DEFAULTS } from '../utils/constants';
import { useHeartbeatStore } from './useHeartbeatStore';

interface VaultStore {
  isInitialized: boolean;
  isRevoked: boolean;
  vaultConfig: VaultConfig | null;
  isSetupComplete: boolean;
  beneficiaries: Beneficiary[];
  defiPositions: DeFiPosition[];
  escalationConfig: EscalationConfig;

  setVaultConfig: (config: VaultConfig | null) => void;
  setRevoked: (revoked: boolean) => void;
  setInitialized: (initialized: boolean) => void;
  setSetupComplete: (complete: boolean) => void;
  addBeneficiary: (b: Beneficiary) => void;
  removeBeneficiary: (wallet: string) => void;
  updateBeneficiary: (wallet: string, updates: Partial<Beneficiary>) => void;
  setBeneficiaries: (beneficiaries: Beneficiary[]) => void;
  setDefiPositions: (positions: DeFiPosition[]) => void;
  setEscalationConfig: (config: EscalationConfig) => void;
  reset: () => void;
  resetForWalletSwitch: () => void;
}

const initialEscalationConfig: EscalationConfig = {
  stage1Duration: ESCALATION_DEFAULTS.stage1,
  stage2Duration: ESCALATION_DEFAULTS.stage2,
  stage3Duration: ESCALATION_DEFAULTS.stage3,
  emergencyContacts: [],
};

export const useVaultStore = create<VaultStore>((set) => ({
  isInitialized: false,
  isRevoked: false,
  vaultConfig: null,
  isSetupComplete: false,
  beneficiaries: [],
  defiPositions: [],
  escalationConfig: initialEscalationConfig,

  setVaultConfig: (config) =>
    set((state) => {
      if (state.isRevoked && config !== null) return {};
      const onChain = config?.beneficiaries ?? [];
      const merged = onChain.map((ob: any, i: number) => {
        const localMatch = state.beneficiaries.find(
          (lb) => lb.wallet.toString() === ob.wallet.toString(),
        );
        return {
          ...ob,
          label: localMatch?.label || ob.label || `Beneficiary ${i + 1}`,
        };
      });

      // Sync heartbeat config from on-chain vault data
      if (config) {
        const interval = config.heartbeatInterval?.toNumber?.() ?? 0;
        if (interval > 0) {
          useHeartbeatStore.getState().setConfig({
            methods: ['active_tap'],
            intervalSeconds: interval,
          });
        }
      }

      return {
        isRevoked: false,
        vaultConfig: config,
        isSetupComplete: config !== null && config.active === true && config.executed !== true,
        beneficiaries: merged,
      };
    }),
  setRevoked: (revoked) => set({ isRevoked: revoked }),
  setInitialized: (initialized) => set({ isInitialized: initialized }),
  setSetupComplete: (complete) => set({ isSetupComplete: complete }),
  addBeneficiary: (b) =>
    set((state) => ({ beneficiaries: [...state.beneficiaries, b] })),
  removeBeneficiary: (wallet) =>
    set((state) => ({
      beneficiaries: state.beneficiaries.filter(
        (b) => b.wallet.toString() !== wallet,
      ),
    })),
  updateBeneficiary: (wallet, updates) =>
    set((state) => ({
      beneficiaries: state.beneficiaries.map((b) =>
        b.wallet.toString() === wallet ? { ...b, ...updates } : b,
      ),
    })),
  setBeneficiaries: (beneficiaries) => set({ beneficiaries }),
  setDefiPositions: (positions) => set({ defiPositions: positions }),
  setEscalationConfig: (config) => set({ escalationConfig: config }),
  reset: () =>
    set({
      isInitialized: false,
      isRevoked: true,
      vaultConfig: null,
      isSetupComplete: false,
      beneficiaries: [],
      defiPositions: [],
      escalationConfig: initialEscalationConfig,
    }),
  resetForWalletSwitch: () =>
    set({
      isInitialized: false,
      isRevoked: false,
      vaultConfig: null,
      isSetupComplete: false,
      beneficiaries: [],
      defiPositions: [],
      escalationConfig: initialEscalationConfig,
    }),
}));
