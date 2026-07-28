// WP5 §6: prove heartbeat logic NEVER triggers notification registration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./useHeartbeat.ts', import.meta.url), 'utf8');

test('heartbeat makes no unsigned background /register call', () => {
  assert.equal(/PushRegistrationService\.register\(/.test(src), false);
});
test('heartbeat acquires no device token, requests no signature, triggers no signed registration', () => {
  assert.equal(/\.getDeviceToken\(/.test(src), false, 'no device-token acquisition');
  assert.equal(/signMessage\s*\(/.test(src), false, 'no wallet signature');
  assert.equal(/registerSigned|attemptSignedRegistration\s*\(/.test(src), false, 'no signed-registration trigger');
});
