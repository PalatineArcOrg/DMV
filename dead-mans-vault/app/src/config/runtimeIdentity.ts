import Constants from 'expo-constants';
import type { DmvBuildIdentity } from './buildIdentityCore';
export {
  classifyMissingAgentForIdentity,
  getRuntimeIdentityPolicy,
  validateRuntimeBuildIdentity,
  type RuntimeIdentityPolicy,
} from './runtimeIdentityCore';
import { validateRuntimeBuildIdentity } from './runtimeIdentityCore';

export function getRuntimeBuildIdentity(): DmvBuildIdentity {
  return validateRuntimeBuildIdentity(
    Constants.expoConfig?.extra?.dmvBuildIdentity
  );
}
