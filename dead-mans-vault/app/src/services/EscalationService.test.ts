import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import {
  clearExecutionAttemptGuardsForTests,
  EscalationService,
  type EscalationStateSink,
} from './EscalationService.ts';
import type { AuthoritativeDeadlineSnapshot } from './OnChainDeadlineService.ts';
import type { EscalationStage } from '../types/escalation.ts';

const PROGRAM = 'GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb';
const OWNER = new PublicKey(Buffer.alloc(32, 2));
const OTHER_OWNER = new PublicKey(Buffer.alloc(32, 3));
const VAULT = new PublicKey(Buffer.alloc(32, 4));
const OTHER_VAULT = new PublicKey(Buffer.alloc(32, 5));
const HEARTBEAT = new PublicKey(Buffer.alloc(32, 6));

function snapshot(
  stage: EscalationStage,
  options: {
    owner?: PublicKey;
    vault?: PublicKey;
    finalDeadline?: number;
    chainUnixTime?: number;
  } = {},
): AuthoritativeDeadlineSnapshot {
  const finalDeadline = options.finalDeadline ?? 1_280;
  const chainUnixTime =
    options.chainUnixTime ??
    ({ 0: 1_050, 1: 1_101, 2: 1_160, 3: 1_220, 4: 1_280 }[
      stage
    ] as number);
  return {
    cluster: 'devnet',
    programId: PROGRAM,
    owner: options.owner ?? OWNER,
    vault: options.vault ?? VAULT,
    heartbeat: HEARTBEAT,
    slot: 50,
    chainUnixTime,
    lastHeartbeat: 1_000,
    lastMethod: 0,
    totalHeartbeats: 4n,
    heartbeatInterval: 100,
    gracePeriod: 180,
    nextDue: 1_100,
    stage1End: 1_160,
    stage2End: 1_220,
    finalDeadline,
    secondsUntilDue: Math.max(0, 1_100 - chainUnixTime),
    secondsOverdue: Math.max(0, chainUnixTime - 1_100),
    secondsUntilFinalDeadline: Math.max(
      0,
      finalDeadline - chainUnixTime,
    ),
    stage,
    executableByTime: stage === 4,
    observedAtMonotonicMs: 5_000,
  };
}

function harness(initialStage: EscalationStage = 0) {
  let stage = initialStage;
  const calls: Array<string> = [];
  const sink: EscalationStateSink = {
    getStage: () => stage,
    resetNonTerminal: () => {
      calls.push('reset');
      stage = 0;
    },
    setStage: (next, chainTime) => {
      calls.push(`stage:${next}:${chainTime}`);
      stage = next;
    },
    setExecutionDeadline: (deadline) => {
      calls.push(`deadline:${deadline}`);
    },
    setExecutionStarted: (started) => {
      calls.push(`execution:${started}`);
    },
  };
  return { sink, calls, getStage: () => stage };
}

test('verified stage 0 resets a prior non-terminal identity state', () => {
  clearExecutionAttemptGuardsForTests();
  const state = harness(2);
  const service = new EscalationService({ state: state.sink });
  service.applyAuthoritativeSnapshot(snapshot(2));
  service.applyAuthoritativeSnapshot(
    snapshot(0, { finalDeadline: 1_500 }),
  );
  assert.equal(state.getStage(), 0);
  assert.match(state.calls.join(','), /reset/);
  assert.doesNotMatch(state.calls.join(','), /execution:true/);
});

test('verified stages 1–3 update UI only and never execute', () => {
  clearExecutionAttemptGuardsForTests();
  const state = harness();
  const executed: Array<number> = [];
  const service = new EscalationService({ state: state.sink });
  service.setExecutionCallback((value) => {
    executed.push(value.stage);
  });
  for (const stage of [1, 2, 3] as const) {
    service.applyAuthoritativeSnapshot(snapshot(stage));
  }
  assert.deepEqual(executed, []);
  assert.equal(state.getStage(), 3);
});

test('fresh verified Stage 4 invokes execution at most once per vault deadline', async () => {
  clearExecutionAttemptGuardsForTests();
  const state = harness();
  let executions = 0;
  const service = new EscalationService({ state: state.sink });
  service.setExecutionCallback(() => {
    executions += 1;
  });
  const stage4 = snapshot(4);
  service.applyAuthoritativeSnapshot(stage4);
  service.applyAuthoritativeSnapshot(stage4);
  await Promise.resolve();
  assert.equal(executions, 1);
  assert.equal(
    state.calls.filter((call) => call === 'execution:true').length,
    1,
  );
});

test('projected Stage 4 and unavailable authority invoke nothing', async () => {
  clearExecutionAttemptGuardsForTests();
  const state = harness();
  let executions = 0;
  const service = new EscalationService({ state: state.sink });
  service.setExecutionCallback(() => {
    executions += 1;
  });
  service.applyProjectedSnapshot(snapshot(4));
  service.markAuthorityUnavailable();
  await Promise.resolve();
  assert.equal(executions, 0);
  assert.doesNotMatch(state.calls.join(','), /execution:true/);
});

test('identity change permits only the newly verified identity callback', async () => {
  clearExecutionAttemptGuardsForTests();
  const state = harness();
  const owners: Array<string> = [];
  const service = new EscalationService({ state: state.sink });
  service.setExecutionCallback((value) => {
    owners.push(value.owner.toBase58());
  });
  service.applyAuthoritativeSnapshot(snapshot(4));
  service.applyAuthoritativeSnapshot(
    snapshot(4, {
      owner: OTHER_OWNER,
      vault: OTHER_VAULT,
      finalDeadline: 1_500,
      chainUnixTime: 1_500,
    }),
  );
  await Promise.resolve();
  assert.deepEqual(owners, [
    OWNER.toBase58(),
    OTHER_OWNER.toBase58(),
  ]);
  assert.match(state.calls.join(','), /reset/);
});

test('callback failure does not cause repeated immediate firing', async () => {
  clearExecutionAttemptGuardsForTests();
  const state = harness();
  let executions = 0;
  const service = new EscalationService({ state: state.sink });
  service.setExecutionCallback(async () => {
    executions += 1;
    throw new Error('mock execution failure');
  });
  const stage4 = snapshot(4);
  service.applyAuthoritativeSnapshot(stage4);
  await Promise.resolve();
  service.applyAuthoritativeSnapshot(stage4);
  await Promise.resolve();
  assert.equal(executions, 1);
});

test('escalation authority has no local-history, wall-clock, or local-stage sender dependency', () => {
  const source = readFileSync(
    new URL('./EscalationService.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /HeartbeatService|getLocalHistoryStatus|getStatus\(|Date\.now/,
  );
  assert.doesNotMatch(
    source,
    /sendHeartbeatReminder|sendUrgentReminder|sendFinalWarning/,
  );
  assert.match(source, /applyAuthoritativeSnapshot/);
  assert.match(source, /applyProjectedSnapshot/);
});
