import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  confirmLocalHeartbeat,
  coordinateHeartbeat,
  isMissingAgentKeyError,
} from './HeartbeatCoordinator.ts';

interface FakeAgent {
  id: string;
}

interface Counters {
  local: number;
  reset: number;
  notification: number;
  loadAgent: number;
  onchain: number;
  signature: number;
  warning: number;
  reload: number;
}

interface CoordinatorHarness {
  counters: Counters;
  events: Array<string>;
  signatures: Array<string>;
  warnings: Array<boolean>;
  run: () => ReturnType<typeof coordinateHeartbeat<FakeAgent>>;
}

function makeHarness(overrides: {
  recordLocalHeartbeat?: () => Promise<void>;
  loadAgentKeypair?: () => Promise<FakeAgent | null>;
  recordHeartbeatOnChain?: (agent: FakeAgent) => Promise<string>;
} = {}): CoordinatorHarness {
  const counters: Counters = {
    local: 0,
    reset: 0,
    notification: 0,
    loadAgent: 0,
    onchain: 0,
    signature: 0,
    warning: 0,
    reload: 0,
  };
  const events: Array<string> = [];
  const signatures: Array<string> = [];
  const warnings: Array<boolean> = [];

  const recordLocalHeartbeat = overrides.recordLocalHeartbeat ?? (async () => {
    counters.local += 1;
    events.push('local heartbeat');
  });
  const loadAgentKeypair = overrides.loadAgentKeypair ?? (async () => {
    counters.loadAgent += 1;
    events.push('load agent');
    return { id: 'agent' };
  });
  const recordHeartbeatOnChain =
    overrides.recordHeartbeatOnChain ?? (async () => {
      counters.onchain += 1;
      events.push('onchain heartbeat');
      return 'mock-signature';
    });

  return {
    counters,
    events,
    signatures,
    warnings,
    run: () => coordinateHeartbeat({
      confirmLocalHeartbeat: () => confirmLocalHeartbeat({
        recordLocalHeartbeat,
        resetLocalEscalation: () => {
          counters.reset += 1;
          events.push('reset escalation');
        },
        sendLocalConfirmationNotification: () => {
          counters.notification += 1;
          events.push('local notification');
        },
      }),
      loadAgentKeypair: async () => {
        if (overrides.loadAgentKeypair) {
          counters.loadAgent += 1;
          events.push('load agent');
        }
        return loadAgentKeypair();
      },
      recordHeartbeatOnChain: async (agent) => {
        if (overrides.recordHeartbeatOnChain) {
          counters.onchain += 1;
          events.push('onchain heartbeat');
        }
        return recordHeartbeatOnChain(agent);
      },
      publishExplorerSignature: (signature) => {
        counters.signature += 1;
        signatures.push(signature);
        events.push('publish signature');
      },
      publishOnChainError: (hasError) => {
        counters.warning += 1;
        warnings.push(hasError);
        events.push(`warning ${String(hasError)}`);
      },
      reloadVaultState: async () => {
        counters.reload += 1;
        events.push('reload vault');
      },
    }),
  };
}

test('successful heartbeat calls every current-flow dependency once', async () => {
  const harness = makeHarness();

  const result = await harness.run();

  assert.deepEqual(result, {
    status: 'confirmed_on_chain',
    signature: 'mock-signature',
  });
  assert.deepEqual(harness.counters, {
    local: 1,
    reset: 1,
    notification: 1,
    loadAgent: 1,
    onchain: 1,
    signature: 1,
    warning: 1,
    reload: 1,
  });
  assert.deepEqual(harness.signatures, ['mock-signature']);
  assert.deepEqual(harness.warnings, [false]);
});

test('current behavior: records local heartbeat and resets escalation before attempting chain submission', async () => {
  const harness = makeHarness();

  await harness.run();

  assert.deepEqual(harness.events, [
    'local heartbeat',
    'reset escalation',
    'local notification',
    'load agent',
    'onchain heartbeat',
    'publish signature',
    'warning false',
    'reload vault',
  ]);
});

test('current behavior: local success survives an onchain failure and vault state still reloads', async () => {
  const failure = new Error('mock preflight failure');
  const harness = makeHarness({
    recordHeartbeatOnChain: async () => {
      throw failure;
    },
  });

  const result = await harness.run();

  assert.deepEqual(result, { status: 'on_chain_failed', error: failure });
  assert.equal(harness.counters.local, 1);
  assert.equal(harness.counters.reset, 1);
  assert.equal(harness.counters.notification, 1);
  assert.equal(harness.counters.signature, 0);
  assert.deepEqual(harness.warnings, [true]);
  assert.equal(harness.counters.reload, 1);
});

test('current KeyManager contract: an absent key throws and is classified as agent_missing', async () => {
  const keyManagerSource = readFileSync(
    new URL('../tee/KeyManager.ts', import.meta.url),
    'utf8',
  );
  assert.match(
    keyManagerSource,
    /async getKeypair\(\): Promise<Keypair>/,
  );
  assert.match(
    keyManagerSource,
    /throw new Error\('No agent key found in secure store'\)/,
  );
  assert.doesNotMatch(keyManagerSource, /getKeypair[\s\S]*?return null/);

  const harness = makeHarness({
    loadAgentKeypair: async () => {
      throw new Error('No agent key found in secure store');
    },
  });

  const result = await harness.run();

  assert.deepEqual(result, { status: 'agent_missing' });
  assert.equal(harness.counters.onchain, 0);
  assert.equal(harness.counters.signature, 0);
  assert.deepEqual(harness.warnings, [true]);
  assert.equal(harness.counters.reload, 1);
  assert.equal(
    isMissingAgentKeyError(
      new Error('No agent key found in secure store'),
    ),
    true,
  );
});

test('local heartbeat failure prevents agent loading, chain submission, signature publication and reload', async () => {
  const failure = new Error('mock sqlite failure');
  const harness = makeHarness({
    recordLocalHeartbeat: async () => {
      harness.counters.local += 1;
      harness.events.push('local heartbeat');
      throw failure;
    },
  });

  const result = await harness.run();

  assert.deepEqual(result, { status: 'local_failed', error: failure });
  assert.equal(harness.counters.reset, 0);
  assert.equal(harness.counters.notification, 0);
  assert.equal(harness.counters.loadAgent, 0);
  assert.equal(harness.counters.onchain, 0);
  assert.equal(harness.counters.signature, 0);
  assert.equal(harness.counters.reload, 0);
});

test('current behavior: concurrent heartbeat calls are not locked or coalesced', async () => {
  const harness = makeHarness();

  const results = await Promise.all([harness.run(), harness.run()]);

  assert.equal(results.length, 2);
  assert.equal(harness.counters.local, 2);
  assert.equal(harness.counters.onchain, 2);
  assert.equal(harness.counters.signature, 2);
  assert.equal(harness.counters.reload, 2);
});

test('Explorer signature is published only after recordHeartbeatOnChain resolves', async () => {
  let resolveSignature: ((signature: string) => void) | null = null;
  let signalChainStarted: (() => void) | null = null;
  const chainStarted = new Promise<void>((resolve) => {
    signalChainStarted = resolve;
  });
  const pendingSignature = new Promise<string>((resolve) => {
    resolveSignature = resolve;
  });
  const harness = makeHarness({
    recordHeartbeatOnChain: async () => {
      signalChainStarted?.();
      return pendingSignature;
    },
  });

  const attempt = harness.run();
  await chainStarted;
  assert.equal(harness.counters.signature, 0);
  assert.deepEqual(harness.signatures, []);

  assert.ok(resolveSignature);
  resolveSignature('late-signature');
  const result = await attempt;

  assert.deepEqual(result, {
    status: 'confirmed_on_chain',
    signature: 'late-signature',
  });
  assert.deepEqual(harness.signatures, ['late-signature']);
});
