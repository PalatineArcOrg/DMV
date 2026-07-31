import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDmvExpoConfig } from '../../app.config.ts';
import {
  LEGACY_ANDROID_PACKAGE,
  LEGACY_EAS_PROJECT_ID,
} from './buildIdentityCore.ts';

function firebase(androidPackage: string): unknown {
  return {
    client: [
      {
        client_info: {
          android_client_info: { package_name: androidPackage },
        },
      },
    ],
  };
}

const legacy = {
  DMV_APP_VARIANT: 'legacy_bridge',
  DMV_BUILD_MODE: 'test',
  DMV_LEGACY_BRIDGE_VERSION: '1.13.22',
  DMV_LEGACY_BRIDGE_VERSION_CODE: '108',
  EXPO_PUBLIC_EXPECTED_CLUSTER: 'devnet',
};

const successor = {
  DMV_APP_VARIANT: 'successor',
  DMV_BUILD_MODE: 'test',
  DMV_SUCCESSOR_ANDROID_PACKAGE: 'com.example.dmv.successor.test',
  DMV_SUCCESSOR_EAS_PROJECT_ID: '44ec509d-011b-4296-8739-a560d65a2cc7',
  DMV_SUCCESSOR_GOOGLE_SERVICES_FILE:
    './fixtures/successor-google-services.json',
  DMV_SUCCESSOR_URI_SCHEME: 'dmv-successor-test',
  DMV_SUCCESSOR_VERSION: '1.0.0',
  DMV_SUCCESSOR_VERSION_CODE: '1',
  EXPO_PUBLIC_EXPECTED_CLUSTER: 'devnet',
};

test('dynamic legacy config is private devnet identity with backup disabled', () => {
  const config = createDmvExpoConfig(legacy, () =>
    firebase(LEGACY_ANDROID_PACKAGE)
  );
  assert.equal(config.android?.package, LEGACY_ANDROID_PACKAGE);
  assert.equal(config.android?.allowBackup, false);
  assert.equal(config.scheme, 'dmv-legacy-bridge');
  assert.equal(config.name, 'DMV Legacy Bridge');
  assert.equal(config.version, '1.13.22');
  assert.equal(
    (config.extra?.eas as { projectId: string }).projectId,
    LEGACY_EAS_PROJECT_ID
  );
  assert.deepEqual(config.updates, { enabled: false });
});

test('dynamic successor config is package/Firebase/EAS isolated', () => {
  const config = createDmvExpoConfig(successor, () =>
    firebase(successor.DMV_SUCCESSOR_ANDROID_PACKAGE)
  );
  assert.equal(
    config.android?.package,
    successor.DMV_SUCCESSOR_ANDROID_PACKAGE
  );
  assert.equal(config.android?.allowBackup, false);
  assert.equal(config.name, 'DMV Successor');
  assert.equal(config.version, '1.0.0');
  assert.notEqual(config.scheme, 'dmv-legacy-bridge');
  assert.notEqual(
    (config.extra?.eas as { projectId: string }).projectId,
    LEGACY_EAS_PROJECT_ID
  );
});

test('dynamic config rejects cross-package Firebase metadata', () => {
  assert.throws(() =>
    createDmvExpoConfig(successor, () => firebase(LEGACY_ANDROID_PACKAGE))
  );
  assert.throws(() =>
    createDmvExpoConfig(legacy, () =>
      firebase(successor.DMV_SUCCESSOR_ANDROID_PACKAGE)
    )
  );
});

test('missing and malformed Firebase configuration fails closed', () => {
  assert.throws(() =>
    createDmvExpoConfig(successor, () => {
      throw new Error('missing');
    })
  );
  assert.throws(() => createDmvExpoConfig(successor, () => ({})));
});
