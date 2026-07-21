// WP3 registration auth-mode config matrix. config.js reads env at import, so each
// case sets env then imports a FRESH module (cache-busted) and exercises
// resolveAuthMode()/assertRegistrationAuthConfig().
import { test } from 'node:test';
import assert from 'node:assert/strict';

const KEYS = [
  'REGISTRATION_AUTH_MODE', 'ADMIN_SECRET', 'REGISTER_SECRET', 'EXPECTED_CLUSTER',
  'PROGRAM_ID', 'NODE_ENV', 'RPC_URL',
];
let seq = 0;
async function load(env) {
  const keys = [...new Set([...KEYS, ...Object.keys(env)])];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await import(`../src/config.js?authcase=${++seq}`);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}
const REG = 'reg-secret-xyz';
const ADM = 'admin-secret-abc';
const dev = { NODE_ENV: 'development' };
const prod = { NODE_ENV: 'production', EXPECTED_CLUSTER: 'devnet', REGISTER_SECRET: REG, ADMIN_SECRET: ADM };

test('dev + missing mode → resolves to legacy', async () => {
  const c = await load({ ...dev });
  assert.equal(c.resolveAuthMode(), c.AUTH_MODE.LEGACY_ONLY);
  assert.doesNotThrow(() => c.assertRegistrationAuthConfig());
});
test('production + missing mode → fatal', async () => {
  const c = await load({ NODE_ENV: 'production', EXPECTED_CLUSTER: 'devnet', REGISTER_SECRET: REG, ADMIN_SECRET: ADM });
  assert.throws(() => c.assertRegistrationAuthConfig(), /REGISTRATION_AUTH_MODE is required/);
});
test('unknown mode → fatal', async () => {
  const c = await load({ ...prod, REGISTRATION_AUTH_MODE: 'Signed' });
  assert.throws(() => c.assertRegistrationAuthConfig(), /Invalid REGISTRATION_AUTH_MODE/);
});
test('production legacy → fatal', async () => {
  const c = await load({ ...prod, REGISTRATION_AUTH_MODE: 'legacy' });
  assert.throws(() => c.assertRegistrationAuthConfig(), /legacy is only permitted/);
});
test('dev legacy → accepted', async () => {
  const c = await load({ ...dev, REGISTRATION_AUTH_MODE: 'legacy' });
  assert.doesNotThrow(() => c.assertRegistrationAuthConfig());
});
test('devnet dual → accepted', async () => {
  const c = await load({ ...prod, REGISTRATION_AUTH_MODE: 'dual' });
  assert.doesNotThrow(() => c.assertRegistrationAuthConfig());
});
test('devnet signed → accepted', async () => {
  const c = await load({ NODE_ENV: 'production', EXPECTED_CLUSTER: 'devnet', ADMIN_SECRET: ADM, REGISTRATION_AUTH_MODE: 'signed' });
  assert.doesNotThrow(() => c.assertRegistrationAuthConfig());
});
test('mainnet dual → fatal (mainnet requires signed)', async () => {
  const c = await load({ ...prod, EXPECTED_CLUSTER: 'mainnet-beta', REGISTRATION_AUTH_MODE: 'dual' });
  assert.throws(() => c.assertRegistrationAuthConfig(), /must be "signed" on mainnet-beta/);
});
test('mainnet legacy → fatal', async () => {
  const c = await load({ ...prod, EXPECTED_CLUSTER: 'mainnet-beta', REGISTRATION_AUTH_MODE: 'legacy' });
  assert.throws(() => c.assertRegistrationAuthConfig());
});
test('mainnet signed → accepted', async () => {
  const c = await load({ NODE_ENV: 'production', EXPECTED_CLUSTER: 'mainnet-beta', ADMIN_SECRET: ADM, REGISTRATION_AUTH_MODE: 'signed' });
  assert.doesNotThrow(() => c.assertRegistrationAuthConfig());
});
test('dual without register secret → fatal', async () => {
  const c = await load({ NODE_ENV: 'production', EXPECTED_CLUSTER: 'devnet', ADMIN_SECRET: ADM, REGISTRATION_AUTH_MODE: 'dual' });
  assert.throws(() => c.assertRegistrationAuthConfig(), /REGISTER_SECRET is required/);
});
test('signed without register secret → accepted', async () => {
  const c = await load({ NODE_ENV: 'production', EXPECTED_CLUSTER: 'devnet', ADMIN_SECRET: ADM, REGISTRATION_AUTH_MODE: 'signed' });
  assert.doesNotThrow(() => c.assertRegistrationAuthConfig());
  // And assertSecureConfig also tolerates a missing REGISTER_SECRET in signed mode.
  assert.doesNotThrow(() => c.assertSecureConfig());
});
test('production without admin secret → fatal', async () => {
  const c = await load({ NODE_ENV: 'production', EXPECTED_CLUSTER: 'devnet', REGISTER_SECRET: REG, REGISTRATION_AUTH_MODE: 'dual' });
  assert.throws(() => c.assertRegistrationAuthConfig(), /ADMIN_SECRET is required/);
});
test('equal admin and register secrets → fatal', async () => {
  const c = await load({ NODE_ENV: 'production', EXPECTED_CLUSTER: 'devnet', REGISTER_SECRET: 'same', ADMIN_SECRET: 'same', REGISTRATION_AUTH_MODE: 'dual' });
  assert.throws(() => c.assertRegistrationAuthConfig(), /ADMIN_SECRET must not equal REGISTER_SECRET/);
});
test('distinct secrets → accepted', async () => {
  const c = await load({ ...prod, REGISTRATION_AUTH_MODE: 'dual' });
  assert.doesNotThrow(() => c.assertRegistrationAuthConfig());
});
test('malformed PROGRAM_ID → fatal', async () => {
  const c = await load({ ...prod, REGISTRATION_AUTH_MODE: 'dual', PROGRAM_ID: 'not-a-pubkey!' });
  assert.throws(() => c.assertRegistrationAuthConfig(), /valid PROGRAM_ID/);
});
test('expectedAudience is the fixed approved constant (not env-controllable)', async () => {
  const { config } = await load({ ...prod, REGISTRATION_AUTH_MODE: 'dual' });
  assert.equal(config.expectedAudience, 'https://notify.palatinearc.com');
});
test('no secret value leaks into any thrown message', async () => {
  const c = await load({ NODE_ENV: 'production', EXPECTED_CLUSTER: 'devnet', REGISTER_SECRET: 'SUPERSECRET1', ADMIN_SECRET: 'SUPERSECRET1', REGISTRATION_AUTH_MODE: 'dual' });
  try {
    c.assertRegistrationAuthConfig();
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal(e.message.includes('SUPERSECRET1'), false);
  }
});
