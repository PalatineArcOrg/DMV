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
  vaultConfig: VaultConfig | null;
  isSetupComplete: boolean;
  beneficiaries: Beneficiary[];
  defiPositions: DeFiPosition[];
  escalationConfig: EscalationConfig;

  setVaultConfig: (config: VaultConfig | null) => void;
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
  vaultConfig: null,
  isSetupComplete: false,
  beneficiaries: [],
  defiPositions: [],
  escalationConfig: initialEscalationConfig,

  setVaultConfig: (config) =>
    set({
      vaultConfig: config,
      isSetupComplete: config !== null && config.active === true && config.executed !== true,
      beneficiaries: config?.beneficiaries ?? [],
    }),
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
      vaultConfig: null,
      isSetupComplete: false,
      beneficiaries: [],
      defiPositions: [],
      escalationConfig: initialEscalationConfig,
    }),
}));
