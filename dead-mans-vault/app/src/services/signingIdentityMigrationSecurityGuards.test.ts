import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

test('EAS profiles are variant-bound, internal and devnet-only', () => {
  const eas = JSON.parse(source('../../eas.json')) as {
    build: Record<
      string,
      {
        distribution: string;
        env: Record<string, string>;
        android: { buildType: string };
      }
    >;
  };
  assert.deepEqual(Object.keys(eas.build).sort(), [
    'legacy-bridge',
    'successor-devnet',
  ]);
  for (const profile of Object.values(eas.build)) {
    assert.equal(profile.distribution, 'internal');
    assert.equal(profile.android.buildType, 'apk');
    assert.equal(profile.env.EXPO_PUBLIC_EXPECTED_CLUSTER, 'devnet');
    assert.match(profile.env.DMV_APP_VARIANT, /^(legacy_bridge|successor)$/);
  }
  assert.doesNotMatch(JSON.stringify(eas), /credential|keystore/i);
  assert.doesNotMatch(JSON.stringify(eas), /mainnet/i);
});

test('source architecture contains no cross-app secret transport', () => {
  const files = [
    './SideBySideMigrationCoordinator.ts',
    '../config/runtimeIdentity.ts',
    '../../app.config.ts',
  ]
    .map(source)
    .join('\n');
  assert.doesNotMatch(files, /sharedUserId|shared_uid/i);
  assert.doesNotMatch(files, /ContentProvider|BroadcastReceiver/i);
  assert.doesNotMatch(files, /Clipboard|QR.*secret|secret.*deep.?link/i);
  assert.doesNotMatch(files, /export.*private.?key|copy.*SecureStore/i);
});

test('incoming coordinator has no automatic startup mutation entrypoint', () => {
  const coordinator = source('./SideBySideMigrationCoordinator.ts');
  assert.doesNotMatch(coordinator, /setInterval|setTimeout/);
  assert.doesNotMatch(coordinator, /sendRawTransaction/);
  assert.doesNotMatch(coordinator, /requestPermissionsAsync/);
  assert.doesNotMatch(coordinator, /getExpoPushTokenAsync/);
  assert.match(coordinator, /createCandidateDeliberately/);
  assert.match(coordinator, /fundCandidateDeliberately/);
  assert.match(coordinator, /submitSuccessorHeartbeatDeliberately/);
});

test('successor token access is gated by a deliberate notification decision', () => {
  const settings = source('../screens/SettingsScreen.tsx');
  assert.match(
    settings,
    /successorTokenObservationAllowed\s*\?\s*PushRegistrationService\.getDeviceToken\(\)/
  );
  assert.match(settings, /record\.notificationDecision === 'registered'/);
  assert.match(settings, /handleEnableSignedNotifications/);
  assert.match(settings, /handleDeferSuccessorNotifications/);
});

test('build identity exposes only non-secret provenance', () => {
  const identity = source('../config/buildIdentityCore.ts');
  const plugin = source('../../plugins/withDmvBuildIdentity.js');
  assert.doesNotMatch(
    `${identity}\n${plugin}`,
    /PRIVATE_KEY|KEYSTORE_PASSWORD|FIREBASE_TOKEN|RPC_SECRET/
  );
  assert.match(plugin, /EXPECTED_CLUSTER/);
  assert.match(plugin, /FIREBASE_PACKAGE/);
});
