// Single import surface for the reused on-chain logic. These modules are the
// EXACT same TypeScript the mobile app ships — imported via the `@app` alias
// (see vite.config.ts) so web and mobile share one source of truth for how
// claim/crank transactions are built. Do not fork these; fix bugs upstream.
export { ClaimService } from '@app/services/ClaimService';
export type { ClaimProgress } from '@app/services/ClaimService';
export { VaultTransactionService } from '@app/services/VaultTransactionService';
export { PROGRAM_ID } from '@app/utils/constants';
export type { AssetAssignment } from '@app/types/vault';
export {
  getRpcUrl,
  isDevnet,
  isCustomRpc,
  networkLabel,
  explorerAddress,
  explorerTx,
  maskRpc,
  loadRpcOverride,
  verifyNetwork,
  DEFAULT_RPC_URL,
  RPC_OVERRIDE_KEY,
} from '@app/utils/rpcConfig';
export type { NetworkVerification, NetworkState } from '@app/utils/rpcConfig';
export { useNetworkStore } from '@app/store/useNetworkStore';
