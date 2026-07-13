// Notify executor token-path revocation (Blocker 1). The token-path try/catch blocks
// (begin_token_dist, specific bequest, token shares, token close) used to SWALLOW a READINESS_REVOKED
// and mark the mint "stuck" — so a crank whose readiness was revoked mid-token-path would return
// success, and the background monitor could then let a later run resume submissions. These tests drive
// the REAL runExecutorInner down each token path with a fake program that holds a mint, revoke
// readiness right before a token submission, and assert the crank ABORTS (throws READINESS_REVOKED).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { runExecutorInner, READINESS_REVOKED } from '../src/executor.js';

const CRANKER = new PublicKey('Vote111111111111111111111111111111111111111');
const VAULT = 'So11111111111111111111111111111111111111112';
const BENEF = new PublicKey('11111111111111111111111111111111');
const MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const bn = (n) => ({ toNumber: () => n });

function makeTokenCtx(rpcLog, { ataExists = true, throwAt = null } = {}) {
  const s = { started: false, tdBegun: false, solPaid: false, completed: false, tokPaid: false, tdClosed: false };
  const execObj = () => ({ solPaidMask: s.solPaid ? 1 : 0, completed: s.completed, transferCount: 0 });
  const tdObj = () => ({ paidMask: s.tokPaid ? 1 : 0, mint: MINT });
  const cfgObj = () => ({
    executed: s.completed, owner: CRANKER, beneficiaries: [{ wallet: BENEF, shareBps: 10000 }],
    hasAssetPlan: false, heartbeatInterval: bn(0), gracePeriod: bn(0), keeperBounty: bn(0),
  });
  // throwAt = { name, error }: the .rpc() of that instruction throws `error` (used to inject a
  // programming fault — a TypeError — and prove it ESCAPES rather than being swallowed as a stuck mint).
  const ix = (name, effect) => ({
    accountsPartial() { return this; }, remainingAccounts() { return this; }, preInstructions() { return this; },
    async rpc() { rpcLog.push(name); if (throwAt && throwAt.name === name) throw throwAt.error; if (effect) effect(); return 'sig'; },
  });
  const program = {
    programId: new PublicKey('GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb'),
    account: {
      vaultConfig: { fetchNullable: async () => cfgObj(), fetch: async () => cfgObj() },
      heartbeatRecord: { fetch: async () => ({ lastHeartbeat: bn(0) }) },
      executionLog: { fetchNullable: async () => (s.started ? execObj() : null), fetch: async () => execObj() },
      assetPlan: { fetch: async () => ({ assignments: [], paidMask: 0 }) },
      tokenDist: { fetchNullable: async () => (s.tdBegun && !s.tdClosed ? tdObj() : null), fetch: async () => tdObj() },
    },
    methods: {
      beginExecution: () => ix('beginExecution', () => { s.started = true; }),
      beginTokenDist: () => ix('beginTokenDist', () => { s.tdBegun = true; }),
      executeSolShares: () => ix('executeSolShares', () => { s.solPaid = true; }),
      finalizeExecution: () => ix('finalizeExecution', () => { s.completed = true; }),
      executeTokenShares: () => ix('executeTokenShares', () => { s.tokPaid = true; }),
      closeTokenDist: () => ix('closeTokenDist', () => { s.tdClosed = true; }),
    },
  };
  return {
    rpcUrl: undefined,
    connection: {
      getRecentPrioritizationFees: async () => [],
      getParsedTokenAccountsByOwner: async (owner, { programId }) =>
        programId.equals(TOKEN_PROGRAM_ID)
          ? { value: [{ account: { data: { parsed: { info: { mint: MINT.toBase58(), tokenAmount: { amount: '100' } } } } } }] }
          : { value: [] },
      // A realistic zeroed token account (owner === token program, >= ACCOUNT_SIZE 165 bytes) so the
      // close path's getAccount()/unpackAccount decodes "no dust" cleanly instead of tripping an
      // internal TypeError (which the now-stricter dust catch correctly escalates). Truthy for the
      // plain existence check in ensureAta.
      getAccountInfo: async () => (ataExists ? { owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(165) } : null),
    },
    cranker: { publicKey: CRANKER },
    provider: { sendAndConfirm: async () => { rpcLog.push('ensureAta'); return 'sig'; } },
    program,
  };
}
function revokeAt(n) { let i = 0; return () => { i += 1; return i < n; }; } // sync guard (notify monitor is background-live)

test('positive control: full token sequence runs when readiness stays true', async () => {
  const rpcLog = [];
  await runExecutorInner(makeTokenCtx(rpcLog), VAULT, () => true);
  assert.deepEqual(rpcLog, ['beginExecution', 'beginTokenDist', 'executeSolShares', 'finalizeExecution', 'executeTokenShares', 'closeTokenDist']);
});

test('revocation at beginTokenDist ABORTS (not swallowed as stuck)', async () => {
  const rpcLog = [];
  await assert.rejects(
    () => runExecutorInner(makeTokenCtx(rpcLog), VAULT, revokeAt(2)),
    (e) => e.message === READINESS_REVOKED,
  );
  assert.deepEqual(rpcLog, ['beginExecution']);
});

test('revocation at executeTokenShares ABORTS (not swallowed)', async () => {
  const rpcLog = [];
  await assert.rejects(
    () => runExecutorInner(makeTokenCtx(rpcLog), VAULT, revokeAt(5)),
    (e) => e.message === READINESS_REVOKED,
  );
  assert.deepEqual(rpcLog, ['beginExecution', 'beginTokenDist', 'executeSolShares', 'finalizeExecution']);
});

test('revocation at closeTokenDist ABORTS (not swallowed)', async () => {
  const rpcLog = [];
  await assert.rejects(
    () => runExecutorInner(makeTokenCtx(rpcLog), VAULT, revokeAt(6)),
    (e) => e.message === READINESS_REVOKED,
  );
  assert.deepEqual(rpcLog, ['beginExecution', 'beginTokenDist', 'executeSolShares', 'finalizeExecution', 'executeTokenShares']);
});

// ── Blocker: PROGRAMMING faults inside the notify executor's token-path catches must ESCAPE (parity
// with the keeper). Each catch now applies isOperationalExecutorError — a TypeError is not operational
// so it rethrows past markStuck up to the caller's fatal handling.
import { makeSubmitGuard, isOperationalExecutorError } from '../src/executor.js';

for (const step of ['beginTokenDist', 'executeTokenShares', 'closeTokenDist']) {
  test(`programming fault (TypeError) at ${step} ESCAPES runExecutorInner (not swallowed as stuck)`, async () => {
    const rpcLog = [];
    const boom = new TypeError(`undefined at ${step}`);
    await assert.rejects(
      () => runExecutorInner(makeTokenCtx(rpcLog, { throwAt: { name: step, error: boom } }), VAULT, () => true),
      (e) => e instanceof TypeError && e === boom,
    );
  });
}

test('an OPERATIONAL error at beginTokenDist is handled (mint stuck) — resolves, does not escape', async () => {
  const rpcLog = [];
  const opErr = Object.assign(new Error('Transaction simulation failed: blockhash not found'), { name: 'SendTransactionError' });
  const r = await runExecutorInner(makeTokenCtx(rpcLog, { throwAt: { name: 'beginTokenDist', error: opErr } }), VAULT, () => true);
  assert.ok(r && typeof r === 'object', 'an operational token failure is skipped as stuck; the run resolves');
  assert.ok(rpcLog.includes('beginExecution'), 'SOL path still ran');
});

test('isOperationalExecutorError: TypeError=false, SendTransactionError/429=true', () => {
  assert.equal(isOperationalExecutorError(new TypeError('x')), false);
  assert.equal(isOperationalExecutorError(new ReferenceError('x')), false);
  assert.equal(isOperationalExecutorError(Object.assign(new Error('x'), { name: 'SendTransactionError', logs: [] })), true);
  assert.equal(isOperationalExecutorError(new Error('429 Too Many Requests')), true);
});

test('isOperationalExecutorError: network TypeError is OPERATIONAL; exact-word programming faults stay FATAL', () => {
  assert.equal(isOperationalExecutorError(new TypeError('fetch failed')), true);
  assert.equal(isOperationalExecutorError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })), true);
  assert.equal(isOperationalExecutorError(Object.assign(new Error('x'), { code: 'ENOTFOUND' })), true);
  // Native programming errors whose message/property name merely contains a transport word stay FATAL.
  assert.equal(isOperationalExecutorError(new ReferenceError('network is not defined')), false);
  assert.equal(isOperationalExecutorError(new TypeError("Cannot read properties of undefined (reading 'socket')")), false);
  assert.equal(isOperationalExecutorError(new TypeError("Cannot read properties of undefined (reading 'timeout')")), false);
  assert.equal(isOperationalExecutorError(new TypeError('Cannot read properties of undefined')), false);
});

// Blocker (this round): parity with the keeper classifier — an ordinary Error whose message merely
// CONTAINS `transaction` / `instruction`, or a NON-EXACT `fetch failed` phrase, is a programming/coder
// fault and must stay FATAL (fail-closed), never swallowed as a stuck mint.
test('isOperationalExecutorError does NOT false-positive on builder/invariant/assertion or non-exact fetch', () => {
  assert.equal(isOperationalExecutorError(new Error('transaction builder invariant violated')), false);
  assert.equal(isOperationalExecutorError(new Error('instruction construction assertion failed')), false);
  assert.equal(isOperationalExecutorError(new Error('unexpected fetch failed validation state')), false);
  // The SPECIFIC operational shapes that share those roots still classify operational.
  assert.equal(isOperationalExecutorError(new Error('Transaction simulation failed: custom program error: 0x1')), true);
  assert.equal(isOperationalExecutorError(new Error('fetch failed')), true); // exact → operational
  assert.equal(isOperationalExecutorError(new Error('blockhash not found')), true);
  // web3.js's real duplicate-tx phrasing ("…already been processed") stays operational even as a bare
  // string (it used to ride on the removed bare `transaction` word).
  assert.equal(isOperationalExecutorError(new Error('This transaction has already been processed')), true);
  // Round-N parity: bare `rpc` / `signature` / `insufficient` removed — a coder fault containing them
  // stays FATAL; only concrete shapes are operational.
  assert.equal(isOperationalExecutorError(new Error('RPC response decoder invariant violated')), false);
  assert.equal(isOperationalExecutorError(new Error('signature scheme not implemented')), false);
  assert.equal(isOperationalExecutorError(new Error('insufficient assignments decoded from state')), false);
  assert.equal(isOperationalExecutorError(new Error('insufficient funds for rent')), true);
  assert.equal(isOperationalExecutorError(new Error('signature verification failed')), true);
  // web3.js TransactionExpiredBlockheightExceededError — kept operational via `block height exceeded`.
  assert.equal(isOperationalExecutorError(new Error('Signature 5xy has expired: block height exceeded.')), true);
  // A named TimeoutError (bounded withTimeout RPC) is operational; a bare "timeout" message is not.
  assert.equal(isOperationalExecutorError(Object.assign(new Error('timeout: x'), { name: 'TimeoutError' })), true);
  assert.equal(isOperationalExecutorError(new Error('timeout configuration invalid')), false);
  // Bare `blockhash` / `simulat` stems replaced with concrete phrases (parity with the keeper): an
  // invariant/coder fault containing those stems stays FATAL; the real RPC messages stay operational.
  assert.equal(isOperationalExecutorError(new Error('blockhash cache invariant violated')), false);
  assert.equal(isOperationalExecutorError(new Error('simulation decoder invariant violated')), false);
  assert.equal(isOperationalExecutorError(new Error('blockhash not found')), true);
  assert.equal(isOperationalExecutorError(new Error('Transaction simulation failed: custom program error: 0x1')), true);
});

// ── Blocker: the pre-submit guard must be ISOLATED per crank. getCtx() returns a cached SINGLETON ctx,
// so two vaults cranking concurrently must NOT share a mutable ctx.guard. These prove ensureAta uses
// THIS run's local guard, never a guard another run left on the shared ctx.
test('guard isolation: a healthy run IGNORES a revoked guard left on the shared ctx by another run', async () => {
  const rpcLog = [];
  // ataExists:false → the vault ATA must be created, so ensureAta actually reaches a guarded submission.
  const ctx = makeTokenCtx(rpcLog, { ataExists: false });
  ctx.guard = () => { throw new Error(READINESS_REVOKED); }; // a concurrent revoked run's leftover on the shared ctx
  // THIS run is healthy → it must COMPLETE (submit its ATA) using its OWN local guard, not the poison.
  await runExecutorInner(ctx, VAULT, () => true);
  assert.ok(rpcLog.includes('ensureAta'), 'ensureAta submitted via the local guard, ignoring the poisoned ctx.guard');
});

test('guard isolation: a revoked run ABORTS even when a healthy guard sits on the shared ctx (no borrowing)', async () => {
  const rpcLog = [];
  const ctx = makeTokenCtx(rpcLog);
  ctx.guard = () => {}; // a concurrent HEALTHY run's guard on the shared ctx (would allow submission)
  // THIS run is revoked (canSubmit false) → it must abort at its FIRST guarded submission using its OWN
  // guard, NOT borrow the healthy ctx.guard and submit.
  await assert.rejects(
    () => runExecutorInner(ctx, VAULT, () => false),
    (e) => e.message === READINESS_REVOKED,
  );
  assert.deepEqual(rpcLog, [], 'nothing submitted — the revoked run did not borrow the healthy ctx.guard');
});

test('makeSubmitGuard: a THROWING canSubmit is converted to READINESS_REVOKED (not an arbitrary error)', () => {
  const guard = makeSubmitGuard(() => { throw new Error('boom from readiness check'); });
  assert.throws(() => guard(), (e) => e.message === READINESS_REVOKED);
});
