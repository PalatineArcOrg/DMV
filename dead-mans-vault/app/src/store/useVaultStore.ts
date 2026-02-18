import { create } from 'zustand';
import { PublicKey } from '@solana/web3.js';
import {
  VaultConfig,
  Beneficiary,
  DeFiPosition,
  EscalationConfig,
} from '../types';
import { ESCALATION_DEFAULTS } from '../utils/constants';

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
      if (state.isRevoked) return {};
      return {
        vaultConfig: config,
        isSetupComplete: config !== null && config.active === true && config.executed !== true,
        beneficiaries: config?.beneficiaries ?? [],
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
}));
