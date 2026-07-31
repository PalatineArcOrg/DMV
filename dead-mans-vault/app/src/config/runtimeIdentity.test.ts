import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyMissingAgentForIdentity,
  getRuntimeIdentityPolicy,
  validateRuntimeBuildIdentity,
} from './runtimeIdentityCore.ts';
import type { DmvBuildIdentity } from './buildIdentityCore.ts';

const legacy: DmvBuildIdentity = {
  variant: 'legacy_bridge',
  androidPackage: 'com.romulusol.deadmansvault',
  easProjectId: 'b1221e75-1816-4ff6-80bf-8f15f31b27d9',
  expectedCluster: 'devnet',
  version: '1.13.22',
  versionCode: 108,
  firebasePackage: 'com.romulusol.deadmansvault',
  signingIdentityLabel: 'historical-certificate-required',
  appName: 'DMV Legacy Bridge',
  uriScheme: 'dmv-legacy-bridge',
  notificationChannelLabel: 'DMV Legacy Bridge',
  migrationMode: true,
  walletIdentityUri: 'https://legacy-bridge.deadmansvault.app',
};

const successor: DmvBuildIdentity = {
  ...legacy,
  variant: 'successor',
  androidPackage: 'com.example.dmv.successor',
  easProjectId: '44ec509d-011b-4296-8739-a560d65a2cc7',
  version: '1.0.0',
  versionCode: 1,
  firebasePackage: 'com.example.dmv.successor',
  signingIdentityLabel: 'successor-controlled-certificate-required',
  appName: 'DMV Successor',
  uriScheme: 'dmv-successor',
  notificationChannelLabel: 'DMV Successor',
  walletIdentityUri: 'https://successor.deadmansvault.app',
};

test('safe build identity validates while mainnet and secret-like extras are absent', () => {
  assert.deepEqual(validateRuntimeBuildIdentity(legacy), legacy);
  assert.deepEqual(validateRuntimeBuildIdentity(successor), successor);
  assert.equal(
    Object.keys(successor).some((key) =>
      /private|secret|credential|keystore|token/i.test(key)
    ),
    false
  );
  assert.throws(() =>
    validateRuntimeBuildIdentity({
      ...successor,
      expectedCluster: 'mainnet-beta',
    })
  );
});

test('successor empty storage is incoming migration, not ordinary corruption', () => {
  assert.equal(
    classifyMissingAgentForIdentity({
      identity: successor,
      hasEverEstablishedActiveKey: false,
    }),
    'incoming_migration_available'
  );
  assert.equal(
    classifyMissingAgentForIdentity({
      identity: successor,
      hasEverEstablishedActiveKey: true,
    }),
    'agent_missing'
  );
  assert.equal(
    classifyMissingAgentForIdentity({
      identity: legacy,
      hasEverEstablishedActiveKey: false,
    }),
    'agent_missing'
  );
});

test('bridge and successor policies never claim automatic migration', () => {
  assert.deepEqual(getRuntimeIdentityPolicy(legacy), {
    variant: 'legacy_bridge',
    incomingMigration: false,
    privateBridge: true,
    mayCreateIncomingCandidate: false,
    mayReauthoriseThisInstallation: true,
  });
  assert.deepEqual(getRuntimeIdentityPolicy(successor), {
    variant: 'successor',
    incomingMigration: true,
    privateBridge: false,
    mayCreateIncomingCandidate: true,
    mayReauthoriseThisInstallation: false,
  });
});
