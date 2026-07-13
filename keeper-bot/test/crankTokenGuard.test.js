// Keeper token-path revocation (Blocker 1). The token-path try/catch blocks (begin_token_dist,
// specific bequest, token shares, token close) used to SWALLOW a KEEPER_HALT and mark the mint
// "stuck" — meaning a revoked crank would report success and could later resume. These tests drive
// the REAL crankVault down each token path with a fake program that has an actual mint, revoke
// readiness immediately before a token submission, and assert the crank ABORTS (throws KEEPER_HALT)
// rather than swallowing it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { crankVault, KEEPER_HALT, getAccountInfoRetry } from '../src/crank.js';

const PROGRAM_ID = new PublicKey('GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb');
const KEEPER = new PublicKey('Vote111111111111111111111111111111111111111');
const VAULT = new PublicKey('So11111111111111111111111111111111111111112');
const BENEF = new PublicKey('11111111111111111111111111111111');
const MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

// Stateful fake program that advances through the full §7 sequence for ONE held mint (no plan).
// `throwAt` = { name, error }: the .rpc() of that instruction throws `error` (used to inject a
// PROGRAMMING fault — a TypeError — and prove it ESCAPES rather than being swallowed as a stuck mint).
function makeTokenCtx(rpcLog, { ataExists = true, throwAt = null } = {}) {
  const s = { started: false, tdBegun: false, solPaid: false, completed: false, tokPaid: false, tdClosed: false };
  const execObj = () => ({ solPaidMask: s.solPaid ? 1 : 0, completed: s.completed, transferCount: 0 });
  const tdObj = () => ({ paidMask: s.tokPaid ? 1 : 0, mint: MINT });
  const ix = (name, effect) => ({
    accountsPartial() { return this; },
    remainingAccounts() { return this; },
    preInstructions() { return this; },
    async rpc() { rpcLog.push(name); if (throwAt && throwAt.name === name) throw throwAt.error; if (effect) effect(); return 'sig'; },
  });
  const program = {
    programId: PROGRAM_ID,
    account: {
      executionLog: { fetchNullable: async () => (s.started ? execObj() : null), fetch: async () => execObj() },
      vaultConfig: {
        fetch: async () => ({
          executed: s.completed, owner: KEEPER,
          beneficiaries: [{ wallet: BENEF, shareBps: 10000 }],
          hasAssetPlan: false, openTokenDists: s.tdBegun && !s.tdClosed ? 1 : 0,
        }),
      },
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
          : { value: [] }, // only the legacy Token program holds the mint; Token-2022 has none
      // A realistic zeroed token account: the real getAccount()/unpackAccount need owner ===
      // the token program and >= ACCOUNT_SIZE (165) bytes; 165 zero bytes decode to amount 0n
      // (no dust, no fee extension), so the close path reads "no dust" cleanly instead of tripping
      // an internal TypeError. Still truthy for ensureAta's plain existence check.
      getAccountInfo: async () => (ataExists ? { owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(165) } : null),
    },
    keeper: { publicKey: KEEPER },
    // ensureAta submits via sendAndConfirm → record it so ATA-creation revocation is observable.
    provider: { sendAndConfirm: async () => { rpcLog.push('ensureAta'); return 'sig'; } },
    program,
  };
}
const CFG = { beneficiaries: [{ wallet: BENEF, shareBps: 10000 }], hasAssetPlan: false, openTokenDists: 0 };

// canSubmit that returns true for the first (n-1) checks, then false — revoking right before the nth
// guarded submission.
function revokeAt(n) {
  let i = 0;
  return async () => { i += 1; return i < n; };
}

test('positive control: the full token sequence runs when readiness stays true', async () => {
  const rpcLog = [];
  const r = await crankVault(makeTokenCtx(rpcLog), VAULT, CFG, { canSubmit: async () => true });
  assert.deepEqual(rpcLog, ['beginExecution', 'beginTokenDist', 'executeSolShares', 'finalizeExecution', 'executeTokenShares', 'closeTokenDist']);
  assert.equal(r, 'executed');
});

test('revocation at beginTokenDist ABORTS (not swallowed as a stuck mint)', async () => {
  const rpcLog = [];
  await assert.rejects(
    () => crankVault(makeTokenCtx(rpcLog), VAULT, CFG, { canSubmit: revokeAt(2) }), // 1=beginExecution, 2=beginTokenDist
    (e) => e.message === KEEPER_HALT,
  );
  assert.deepEqual(rpcLog, ['beginExecution'], 'begin_token_dist suppressed — the catch rethrew KEEPER_HALT');
});

test('revocation at ATA creation (before begin_token_dist) ABORTS', async () => {
  const rpcLog = [];
  await assert.rejects(
    () => crankVault(makeTokenCtx(rpcLog, { ataExists: false }), VAULT, CFG, { canSubmit: revokeAt(2) }),
    (e) => e.message === KEEPER_HALT,
  );
  assert.deepEqual(rpcLog, ['beginExecution'], 'no ensureAta submit, no beginTokenDist');
});

test('revocation at executeTokenShares ABORTS (not swallowed)', async () => {
  const rpcLog = [];
  // 1 begin, 2 beginTokenDist, 3 solShares, 4 finalize, 5 tokenShares
  await assert.rejects(
    () => crankVault(makeTokenCtx(rpcLog), VAULT, CFG, { canSubmit: revokeAt(5) }),
    (e) => e.message === KEEPER_HALT,
  );
  assert.deepEqual(rpcLog, ['beginExecution', 'beginTokenDist', 'executeSolShares', 'finalizeExecution']);
});

test('revocation at closeTokenDist ABORTS (not swallowed)', async () => {
  const rpcLog = [];
  await assert.rejects(
    () => crankVault(makeTokenCtx(rpcLog), VAULT, CFG, { canSubmit: revokeAt(6) }),
    (e) => e.message === KEEPER_HALT,
  );
  assert.deepEqual(rpcLog, ['beginExecution', 'beginTokenDist', 'executeSolShares', 'finalizeExecution', 'executeTokenShares']);
});

// ── Blocker: PROGRAMMING faults in the token-path catches must ESCAPE, not be swallowed as a stuck
// mint. Each broad token catch now applies isOperationalCrankError() — a TypeError (native programming
// fault) is NOT operational, so it rethrows past markStuck/skipped up to the process fatal guard.
// Contrast: the KEEPER_HALT tests above (revocation aborts) and the operational-skip test below.
const NEVER_REVOKE = async () => true;

// #1 (full pass-deadline): every internal read in crankVault is bounded by the per-vault deadline, so a
// single never-settling read cannot prevent the pass from returning. With a short injected deadline the
// crank rejects with a TimeoutError (which tick() then degrades on) instead of hanging forever.
test('#1: a hung internal read is bounded by the pass deadline → TimeoutError (crank returns, does not hang)', async () => {
  const rpcLog = [];
  const ctx = makeTokenCtx(rpcLog);
  ctx.passDeadlineMs = 40; // tiny budget for the test
  ctx.program.account.executionLog.fetchNullable = () => new Promise(() => {}); // begin_execution read never settles
  const start = Date.now();
  await assert.rejects(
    () => crankVault(ctx, VAULT, CFG, { canSubmit: NEVER_REVOKE }),
    (e) => e.name === 'TimeoutError',
  );
  assert.ok(Date.now() - start < 1000, 'bounded by the pass deadline, did not hang');
});

test('programming fault (TypeError) at beginTokenDist ESCAPES (not swallowed as a stuck mint)', async () => {
  const rpcLog = [];
  const boom = new TypeError('undefined is not a function at begin_token_dist');
  await assert.rejects(
    () => crankVault(makeTokenCtx(rpcLog, { throwAt: { name: 'beginTokenDist', error: boom } }), VAULT, CFG, { canSubmit: NEVER_REVOKE }),
    (e) => e instanceof TypeError && e === boom,
  );
  assert.deepEqual(rpcLog, ['beginExecution', 'beginTokenDist'], 'the fault rethrew instead of marking the mint stuck and continuing');
});

test('programming fault (TypeError) at executeTokenShares ESCAPES (not swallowed as a stuck mint)', async () => {
  const rpcLog = [];
  const boom = new TypeError('cannot read properties of undefined at execute_token_shares');
  await assert.rejects(
    () => crankVault(makeTokenCtx(rpcLog, { throwAt: { name: 'executeTokenShares', error: boom } }), VAULT, CFG, { canSubmit: NEVER_REVOKE }),
    (e) => e instanceof TypeError && e === boom,
  );
  assert.deepEqual(rpcLog, ['beginExecution', 'beginTokenDist', 'executeSolShares', 'finalizeExecution', 'executeTokenShares']);
});

test('programming fault (TypeError) at closeTokenDist ESCAPES (not swallowed as a stuck mint)', async () => {
  const rpcLog = [];
  const boom = new TypeError('bad decode at close_token_dist');
  await assert.rejects(
    () => crankVault(makeTokenCtx(rpcLog, { throwAt: { name: 'closeTokenDist', error: boom } }), VAULT, CFG, { canSubmit: NEVER_REVOKE }),
    (e) => e instanceof TypeError && e === boom,
  );
  assert.deepEqual(rpcLog, ['beginExecution', 'beginTokenDist', 'executeSolShares', 'finalizeExecution', 'executeTokenShares', 'closeTokenDist']);
});

// A held mint that is ALSO a specific SPL bequest to BENEF, exercising the execute_specific_asset path.
function makePlanTokenCtx(rpcLog, { throwAt = null } = {}) {
  const s = { started: false, tdBegun: false };
  const ASSIGN = { mint: MINT, amount: 5n, beneficiaryIndex: 0, isNft: false };
  const execObj = () => ({ solPaidMask: 0, completed: false, transferCount: 0 });
  const planObj = () => ({ assignments: [ASSIGN], paidMask: 0 });
  const tdObj = () => ({ paidMask: 0, mint: MINT });
  const ix = (name, effect) => ({
    accountsPartial() { return this; },
    remainingAccounts() { return this; },
    preInstructions() { return this; },
    async rpc() { rpcLog.push(name); if (throwAt && throwAt.name === name) throw throwAt.error; if (effect) effect(); return 'sig'; },
  });
  const program = {
    programId: PROGRAM_ID,
    account: {
      executionLog: { fetchNullable: async () => (s.started ? execObj() : null), fetch: async () => execObj() },
      vaultConfig: {
        fetch: async () => ({
          executed: false, owner: KEEPER,
          beneficiaries: [{ wallet: BENEF, shareBps: 10000 }],
          hasAssetPlan: true, openTokenDists: s.tdBegun ? 1 : 0,
        }),
      },
      assetPlan: { fetch: async () => planObj() },
      tokenDist: { fetchNullable: async () => (s.tdBegun ? tdObj() : null), fetch: async () => tdObj() },
    },
    methods: {
      beginExecution: () => ix('beginExecution', () => { s.started = true; }),
      beginTokenDist: () => ix('beginTokenDist', () => { s.tdBegun = true; }),
      executeSpecificAsset: () => ix('executeSpecificAsset'),
      executeSolShares: () => ix('executeSolShares'),
      finalizeExecution: () => ix('finalizeExecution'),
      executeTokenShares: () => ix('executeTokenShares'),
      closeTokenDist: () => ix('closeTokenDist'),
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
      getAccountInfo: async () => ({ owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(165) }),
    },
    keeper: { publicKey: KEEPER },
    provider: { sendAndConfirm: async () => { rpcLog.push('ensureAta'); return 'sig'; } },
    program,
  };
}
const PLAN_CFG = { beneficiaries: [{ wallet: BENEF, shareBps: 10000 }], hasAssetPlan: true, openTokenDists: 0 };

test('programming fault (TypeError) at executeSpecificAsset ESCAPES (not swallowed as a stuck bequest)', async () => {
  const rpcLog = [];
  const boom = new TypeError('undefined beneficiary index at execute_specific_asset');
  await assert.rejects(
    () => crankVault(makePlanTokenCtx(rpcLog, { throwAt: { name: 'executeSpecificAsset', error: boom } }), VAULT, PLAN_CFG, { canSubmit: NEVER_REVOKE }),
    (e) => e instanceof TypeError && e === boom,
  );
  assert.deepEqual(rpcLog, ['beginExecution', 'beginTokenDist', 'executeSpecificAsset'], 'the fault rethrew instead of skipping the bequest and continuing');
});

test('OPERATIONAL error at beginTokenDist BLOCKS finalize (mint stuck) — no premature executed, crank resolves', async () => {
  const rpcLog = [];
  // A revert/RPC-shaped failure IS operational → the classifier lets it be skipped as a stuck mint; the
  // crank resolves (does not escape). BUT it must NOT finalize: a failed begin_token_dist never opened
  // the TokenDist (open_token_dists stays 0), and executed-vault cleanup only re-cranks when
  // open_token_dists > 0 — so finalizing here would STRAND the mint's residual (unretriable). SOL still
  // distributes; finalize is withheld so the vault stays non-executed for the next tick to retry.
  const opErr = Object.assign(new Error('Transaction simulation failed: blockhash not found'), { name: 'SendTransactionError' });
  const r = await crankVault(makeTokenCtx(rpcLog, { throwAt: { name: 'beginTokenDist', error: opErr } }), VAULT, CFG, { canSubmit: NEVER_REVOKE });
  assert.deepEqual(rpcLog, ['beginExecution', 'beginTokenDist', 'executeSolShares'], 'finalize withheld while a mint is stuck');
  assert.doesNotMatch(r, /^executed/, 'not prematurely marked executed while a mint is stuck');
  assert.match(r, /skipped 1/);
});

test('a transient beginTokenDist failure is RETRIED next tick and then finalizes (no strand)', async () => {
  const rpcLog = [];
  const throwAt = { name: 'beginTokenDist', error: Object.assign(new Error('blockhash not found'), { name: 'SendTransactionError' }) };
  const ctx = makeTokenCtx(rpcLog, { throwAt }); // shared ctx (state persists across the two crank passes)
  // Tick 1: begin_token_dist fails → stuck → finalize blocked → NOT executed.
  const r1 = await crankVault(ctx, VAULT, CFG, { canSubmit: NEVER_REVOKE });
  assert.doesNotMatch(r1, /^executed/);
  // Tick 2: the transient blip is gone (stop throwing). begin_token_dist now succeeds → TokenDist opens →
  // finalize runs → executed. Proves the withheld finalize let the next tick complete the mint.
  throwAt.name = '__cleared__';
  rpcLog.length = 0;
  const r2 = await crankVault(ctx, VAULT, CFG, { canSubmit: NEVER_REVOKE });
  assert.ok(rpcLog.includes('beginTokenDist'), 'retried the previously-stuck begin_token_dist');
  assert.ok(rpcLog.includes('finalizeExecution'), 'finalized once the mint opened');
  assert.match(r2, /^executed/);
});

// ── Blocker: getAccountInfoRetry() must not swallow PROGRAMMING faults. It retries recognized
// operational RPC failures (429/null) but a native fault (TypeError/etc.) must ESCAPE to the fatal
// guard, not be retried away and returned as null (which would silently drop a plan mint from the tick).
const PLAN_MINT = new PublicKey('4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R');

// A plan mint the vault does NOT hold, so collectMints reaches getAccountInfoRetry(mint). getAccountInfo
// throws the injected error on the mint-owner lookup.
function makeUnheldPlanCtx(rpcLog, getAccountInfoImpl) {
  const s = { started: false };
  const ix = (name, effect) => ({
    accountsPartial() { return this; }, remainingAccounts() { return this; }, preInstructions() { return this; },
    async rpc() { rpcLog.push(name); if (effect) effect(); return 'sig'; },
  });
  return {
    rpcUrl: undefined,
    connection: {
      getRecentPrioritizationFees: async () => [],
      getParsedTokenAccountsByOwner: async () => ({ value: [] }), // vault holds NO tokens → plan mint hits the lookup
      getAccountInfo: getAccountInfoImpl,
    },
    keeper: { publicKey: KEEPER },
    provider: { sendAndConfirm: async () => 'sig' },
    program: {
      programId: PROGRAM_ID,
      account: {
        executionLog: { fetchNullable: async () => (s.started ? { solPaidMask: 0, completed: false } : null), fetch: async () => ({ solPaidMask: 0, completed: false }) },
        vaultConfig: { fetch: async () => ({ executed: false, owner: KEEPER, beneficiaries: [{ wallet: BENEF, shareBps: 10000 }], hasAssetPlan: true, openTokenDists: 0 }) },
        assetPlan: { fetch: async () => ({ assignments: [{ mint: PLAN_MINT, amount: 5n, beneficiaryIndex: 0, isNft: false }], paidMask: 0 }) },
        tokenDist: { fetchNullable: async () => null },
      },
      methods: { beginExecution: () => ix('beginExecution', () => { s.started = true; }) },
    },
  };
}

test('getAccountInfoRetry: a TypeError from the mint-owner lookup ESCAPES (not retried/omitted)', async () => {
  const boom = new TypeError('cannot read owner of undefined');
  await assert.rejects(
    () => getAccountInfoRetry({ getAccountInfo: async () => { throw boom; } }, PLAN_MINT),
    (e) => e instanceof TypeError && e === boom,
  );
});

test('getAccountInfoRetry: a recognized RPC/429 failure retries and RECOVERS', async () => {
  let n = 0;
  const acc = { owner: TOKEN_PROGRAM_ID };
  const got = await getAccountInfoRetry({
    getAccountInfo: async () => { n += 1; if (n === 1) throw new Error('429 Too Many Requests'); return acc; },
  }, PLAN_MINT);
  assert.equal(got, acc, 'the operational 429 was retried and the second attempt recovered');
  assert.equal(n, 2);
});

test('crankVault: a TypeError in the plan mint-owner lookup ESCAPES the whole crank (not swallowed)', async () => {
  const rpcLog = [];
  const boom = new TypeError('undefined is not an object (mint owner)');
  await assert.rejects(
    () => crankVault(makeUnheldPlanCtx(rpcLog, async () => { throw boom; }), VAULT, PLAN_CFG, { canSubmit: NEVER_REVOKE }),
    (e) => e instanceof TypeError && e === boom,
  );
  assert.deepEqual(rpcLog, ['beginExecution'], 'the fault escaped during mint discovery — no token submissions');
});
