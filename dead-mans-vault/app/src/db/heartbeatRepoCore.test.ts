import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  insertConfirmedHeartbeat,
  insertNonAuthoritativeLocalHeartbeat,
  type HeartbeatInsertValue,
} from './heartbeatRepoCore.ts';

test('confirmed heartbeat inserts the explicit onchain timestamp and transaction signature', async () => {
  const calls: Array<{
    statement: string;
    values: Array<HeartbeatInsertValue>;
  }> = [];

  await insertConfirmedHeartbeat(
    {
      method: 'active_tap',
      onChainTimestamp: 1_700_000_001,
      transactionSignature: 'confirmed-signature',
    },
    async (statement, values) => {
      calls.push({ statement, values });
    },
  );

  assert.deepEqual(calls, [{
    statement:
      'INSERT INTO heartbeat_history (timestamp, method, on_chain_tx) ' +
      'SELECT ?, ?, ? WHERE NOT EXISTS ' +
      '(SELECT 1 FROM heartbeat_history WHERE on_chain_tx = ?)',
    values: [
      1_700_000_001,
      'active_tap',
      'confirmed-signature',
      'confirmed-signature',
    ],
  }]);
});

test('confirmed heartbeat insert is idempotent by transaction signature', () => {
  const source = readFileSync(
    new URL('./heartbeatRepoCore.ts', import.meta.url),
    'utf8',
  );
  assert.match(
    source,
    /WHERE NOT EXISTS.*on_chain_tx = \?/s,
  );
});

test('confirmed heartbeat persistence never derives a device-clock timestamp', () => {
  const source = readFileSync(
    new URL('./heartbeatRepoCore.ts', import.meta.url),
    'utf8',
  );
  const confirmedFunction = source.slice(
    source.indexOf('export async function insertConfirmedHeartbeat'),
    source.indexOf(
      'export async function insertNonAuthoritativeLocalHeartbeat',
    ),
  );

  assert.doesNotMatch(confirmedFunction, /Date\.now/);
  assert.match(confirmedFunction, /input\.onChainTimestamp/);
  assert.match(confirmedFunction, /input\.transactionSignature/);
});

test('confirmed heartbeat rejects invalid timestamp or absent signature', async () => {
  const runInsert = async () => {};

  await assert.rejects(
    insertConfirmedHeartbeat(
      {
        method: 'active_tap',
        onChainTimestamp: Number.MAX_SAFE_INTEGER + 1,
        transactionSignature: 'signature',
      },
      runInsert,
    ),
    /timestamp is invalid/,
  );
  await assert.rejects(
    insertConfirmedHeartbeat(
      {
        method: 'active_tap',
        onChainTimestamp: 1_000,
        transactionSignature: '',
      },
      runInsert,
    ),
    /signature is required/,
  );
});

test('isolated non-authoritative local insertion has no transaction signature', async () => {
  const values: Array<Array<HeartbeatInsertValue>> = [];

  await insertNonAuthoritativeLocalHeartbeat(
    'on_chain_activity',
    1_234,
    async (_statement, insertedValues) => {
      values.push(insertedValues);
    },
  );

  assert.deepEqual(values, [[1_234, 'on_chain_activity', null]]);
});

test('HeartbeatService refreshes Zustand only after confirmed persistence', () => {
  const source = readFileSync(
    new URL('../services/HeartbeatService.ts', import.meta.url),
    'utf8',
  );

  assert.match(
    source,
    /await persistConfirmedHeartbeat\(input\);[\s\S]*await this\.getLocalHistoryStatus\(\);[\s\S]*useHeartbeatStore\.getState\(\)\.setStatus\(status\)/,
  );
  assert.match(
    source,
    /Activity\/history display only[\s\S]*never used[\s\S]*authoritative deadline/,
  );
  assert.match(source, /recordNonAuthoritativeActivityHeartbeat/);
  assert.doesNotMatch(source, /async confirmHeartbeat/);
});
