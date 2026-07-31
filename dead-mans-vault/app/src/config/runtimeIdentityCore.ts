import {
  LEGACY_ANDROID_PACKAGE,
  type DmvBuildIdentity,
} from './buildIdentityCore.ts';

export type RuntimeIdentityPolicy =
  | {
      variant: 'legacy_bridge';
      incomingMigration: false;
      privateBridge: true;
      mayCreateIncomingCandidate: false;
      mayReauthoriseThisInstallation: true;
    }
  | {
      variant: 'successor';
      incomingMigration: true;
      privateBridge: false;
      mayCreateIncomingCandidate: true;
      mayReauthoriseThisInstallation: false;
    };

export function validateRuntimeBuildIdentity(value: unknown): DmvBuildIdentity {
  if (!value || typeof value !== 'object') {
    throw new Error('DMV build identity is missing');
  }
  const identity = value as Partial<DmvBuildIdentity>;
  if (
    (identity.variant !== 'legacy_bridge' &&
      identity.variant !== 'successor') ||
    identity.expectedCluster !== 'devnet' ||
    typeof identity.androidPackage !== 'string' ||
    typeof identity.easProjectId !== 'string' ||
    typeof identity.version !== 'string' ||
    !Number.isSafeInteger(identity.versionCode) ||
    identity.versionCode! <= 0 ||
    identity.firebasePackage !== identity.androidPackage ||
    identity.migrationMode !== true
  ) {
    throw new Error('DMV build identity is invalid');
  }
  if (
    identity.variant === 'legacy_bridge' &&
    identity.androidPackage !== LEGACY_ANDROID_PACKAGE
  ) {
    throw new Error('Legacy bridge package identity is invalid');
  }
  if (
    identity.variant === 'successor' &&
    identity.androidPackage === LEGACY_ANDROID_PACKAGE
  ) {
    throw new Error('Successor package identity is invalid');
  }
  return identity as DmvBuildIdentity;
}

export function getRuntimeIdentityPolicy(
  identity: DmvBuildIdentity
): RuntimeIdentityPolicy {
  return identity.variant === 'legacy_bridge'
    ? {
        variant: 'legacy_bridge',
        incomingMigration: false,
        privateBridge: true,
        mayCreateIncomingCandidate: false,
        mayReauthoriseThisInstallation: true,
      }
    : {
        variant: 'successor',
        incomingMigration: true,
        privateBridge: false,
        mayCreateIncomingCandidate: true,
        mayReauthoriseThisInstallation: false,
      };
}

export function classifyMissingAgentForIdentity(input: {
  identity: DmvBuildIdentity;
  hasEverEstablishedActiveKey: boolean;
}): 'agent_missing' | 'incoming_migration_available' {
  return input.identity.variant === 'successor' &&
    !input.hasEverEstablishedActiveKey
    ? 'incoming_migration_available'
    : 'agent_missing';
}
