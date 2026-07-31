import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LEGACY_ANDROID_PACKAGE,
  LEGACY_EAS_PROJECT_ID,
  getFirebaseAndroidPackages,
  resolveDmvBuildIdentity,
  validateFirebasePackage,
} from './buildIdentityCore.ts';

const legacyEnvironment = {
  DMV_APP_VARIANT: 'legacy_bridge',
  DMV_BUILD_MODE: 'controlled_release',
  DMV_LEGACY_BRIDGE_VERSION: '1.13.22',
  DMV_LEGACY_BRIDGE_VERSION_CODE: '108',
  EXPO_PUBLIC_EXPECTED_CLUSTER: 'devnet',
};

const successorEnvironment = {
  DMV_APP_VARIANT: 'successor',
  DMV_BUILD_MODE: 'controlled_release',
  DMV_SUCCESSOR_ANDROID_PACKAGE: 'com.example.dmv.successor',
  DMV_SUCCESSOR_EAS_PROJECT_ID: '44ec509d-011b-4296-8739-a560d65a2cc7',
  DMV_SUCCESSOR_GOOGLE_SERVICES_FILE:
    './fixtures/successor-google-services.json',
  DMV_SUCCESSOR_URI_SCHEME: 'dmv-successor',
  DMV_SUCCESSOR_VERSION: '1.0.0',
  DMV_SUCCESSOR_VERSION_CODE: '1',
  EXPO_PUBLIC_EXPECTED_CLUSTER: 'devnet',
};

test('legacy variant preserves the installed package and legacy EAS identity', () => {
  const { identity } = resolveDmvBuildIdentity(legacyEnvironment);
  assert.equal(identity.variant, 'legacy_bridge');
  assert.equal(identity.androidPackage, LEGACY_ANDROID_PACKAGE);
  assert.equal(identity.easProjectId, LEGACY_EAS_PROJECT_ID);
  assert.equal(identity.expectedCluster, 'devnet');
  assert.equal(identity.appName, 'DMV Legacy Bridge');
});

test('successor requires a distinct package and EAS project', () => {
  const { identity } = resolveDmvBuildIdentity(successorEnvironment);
  assert.equal(identity.variant, 'successor');
  assert.notEqual(identity.androidPackage, LEGACY_ANDROID_PACKAGE);
  assert.notEqual(identity.easProjectId, LEGACY_EAS_PROJECT_ID);
});

test('identity mixing and absent successor provisioning fail closed', () => {
  assert.throws(() =>
    resolveDmvBuildIdentity({
      ...successorEnvironment,
      DMV_SUCCESSOR_ANDROID_PACKAGE: LEGACY_ANDROID_PACKAGE,
    })
  );
  assert.throws(() =>
    resolveDmvBuildIdentity({
      ...successorEnvironment,
      DMV_SUCCESSOR_EAS_PROJECT_ID: LEGACY_EAS_PROJECT_ID,
    })
  );
  assert.throws(() =>
    resolveDmvBuildIdentity({
      ...successorEnvironment,
      DMV_SUCCESSOR_ANDROID_PACKAGE: '',
    })
  );
});

test('both identities reject mainnet and unknown variants', () => {
  assert.throws(() =>
    resolveDmvBuildIdentity({
      ...legacyEnvironment,
      EXPO_PUBLIC_EXPECTED_CLUSTER: 'mainnet-beta',
    })
  );
  assert.throws(() =>
    resolveDmvBuildIdentity({
      ...successorEnvironment,
      EXPO_PUBLIC_EXPECTED_CLUSTER: 'mainnet-beta',
    })
  );
  assert.throws(() =>
    resolveDmvBuildIdentity({
      ...legacyEnvironment,
      DMV_APP_VARIANT: 'production',
    })
  );
});

test('variant names and URI schemes remain visibly distinct', () => {
  const legacy = resolveDmvBuildIdentity(legacyEnvironment).identity;
  const successor = resolveDmvBuildIdentity(successorEnvironment).identity;
  assert.notEqual(legacy.appName, successor.appName);
  assert.notEqual(legacy.uriScheme, successor.uriScheme);
  assert.notEqual(
    legacy.notificationChannelLabel,
    successor.notificationChannelLabel
  );
});

test('temporary fixture packages are accepted only in test mode', () => {
  assert.throws(() =>
    resolveDmvBuildIdentity({
      ...successorEnvironment,
      DMV_SUCCESSOR_ANDROID_PACKAGE: 'com.example.dmv.successor.test',
    })
  );
  const fixture = resolveDmvBuildIdentity({
    ...successorEnvironment,
    DMV_BUILD_MODE: 'test',
    DMV_SUCCESSOR_ANDROID_PACKAGE: 'com.example.dmv.successor.test',
  });
  assert.equal(
    fixture.identity.androidPackage,
    'com.example.dmv.successor.test'
  );
});

test('Firebase package metadata is validated without exposing other fields', () => {
  const fixture = {
    project_info: {
      project_id: 'synthetic-do-not-log',
    },
    client: [
      {
        client_info: {
          android_client_info: {
            package_name: LEGACY_ANDROID_PACKAGE,
          },
        },
        api_key: [{ current_key: 'synthetic-never-log' }],
      },
    ],
  };
  assert.deepEqual(getFirebaseAndroidPackages(fixture), [
    LEGACY_ANDROID_PACKAGE,
  ]);
  assert.equal(
    validateFirebasePackage(fixture, LEGACY_ANDROID_PACKAGE),
    undefined
  );
  assert.throws(() =>
    validateFirebasePackage(fixture, 'com.example.dmv.successor')
  );
  assert.throws(() =>
    validateFirebasePackage(
      {
        client: [
          ...fixture.client,
          {
            client_info: {
              android_client_info: {
                package_name: 'com.example.dmv.successor',
              },
            },
          },
        ],
      },
      LEGACY_ANDROID_PACKAGE
    )
  );
  assert.throws(() => validateFirebasePackage({}, LEGACY_ANDROID_PACKAGE));
});
