import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

test('the heartbeat exact message is prepared once before agent signing and journal submission', () => {
  const vaultTransactions = source('./VaultTransactionService.ts');
  const preparation = vaultTransactions.slice(
    vaultTransactions.indexOf('async prepareHeartbeatTransaction'),
    vaultTransactions.indexOf('async recordHeartbeatOnChain'),
  );
  const submission = vaultTransactions.slice(
    vaultTransactions.indexOf('async recordHeartbeatOnChain'),
    vaultTransactions.indexOf('async buildUpdateVaultTx'),
  );
  assert.equal(
    (preparation.match(/\.recordHeartbeat\(/g) ?? []).length,
    1,
  );
  assert.equal(
    (preparation.match(/getLatestBlockhash/g) ?? []).length,
    1,
  );
  assert.equal(
    (preparation.match(/connection\.getFeeForMessage/g) ?? []).length,
    1,
  );
  assert.equal(
    (preparation.match(/getBalanceAndContext/g) ?? []).length,
    1,
  );
  assert.match(
    preparation,
    /addPriorityFee[\s\S]*feePayer = agentPubkey[\s\S]*getLatestBlockhash[\s\S]*compileMessage[\s\S]*feeReadinessService\.check/,
  );
  assert.doesNotMatch(preparation, /\.sign\(|partialSign|serialize\(/);
  assert.match(
    submission,
    /prepared\.transaction[\s\S]*prepared\.blockhashValidity/,
  );
  assert.doesNotMatch(
    submission,
    /getLatestBlockhash|getFeeForMessage|addPriorityFee|recordHeartbeat\(/,
  );
});

test('coordinator reconciles, validates, fee-checks, then signs without owner-wallet entry', () => {
  const coordinator = source('./HeartbeatCoordinator.ts');
  const attempt = coordinator.slice(
    coordinator.indexOf('attempt: async'),
    coordinator.lastIndexOf('} finally {'),
  );
  const unresolved = attempt.indexOf('getUnresolvedOperation');
  const readiness = attempt.indexOf('checkAgentReadiness');
  const feePreparation = attempt.indexOf(
    'prepareHeartbeatTransaction',
  );
  const signing = attempt.indexOf('recordHeartbeatOnChain');
  assert.ok(unresolved >= 0);
  assert.ok(unresolved < readiness);
  assert.ok(readiness < feePreparation);
  assert.ok(feePreparation < signing);
  assert.match(
    attempt,
    /status === 'insufficient'[\s\S]*insufficient_agent_funds/,
  );
  assert.doesNotMatch(coordinator, /signTransaction|AgentTopUp|SystemProgram/);
  assert.doesNotMatch(attempt, /while\s*\(|setInterval|retry/i);
});

test('reserve target is centralized and activation uses the same product value', () => {
  const constants = source('./agentFundingPolicy.ts');
  const setup = source('../screens/EstateReviewScreen.tsx');
  assert.match(
    constants,
    /AGENT_RECOMMENDED_RESERVE_LAMPORTS = 5_000_000/,
  );
  assert.match(setup, /AGENT_RECOMMENDED_RESERVE_LAMPORTS/);
  assert.doesNotMatch(setup, /AGENT_FUNDING_LAMPORTS/);
  assert.equal((setup.match(/5_000_000/g) ?? []).length, 0);
});

test('fee lifecycle refresh is read-only and top-up remains an explicit UI handler', () => {
  const card = source('../components/AgentFeeCard.tsx');
  const refreshStart = card.indexOf('async function readAgentFeeSnapshot');
  const refreshEnd = card.indexOf('export function AgentFeeCard');
  const refresh = card.slice(refreshStart, refreshEnd);
  assert.match(refresh, /prepareHeartbeatTransaction/);
  assert.match(refresh, /agentFeeRefreshes/);
  assert.match(card, /useFocusEffect/);
  assert.match(card, /AppState\.addEventListener/);
  assert.doesNotMatch(
    refresh,
    /signTransaction|sendRawTransaction|SystemProgram|topUp\(/,
  );
  assert.doesNotMatch(card, /setInterval|while\s*\(/);
  assert.match(card, /requestTopUpConfirmation/);
  assert.match(card, /signTransaction/);
});

test('no prohibited fee payer, automatic funding, secret, program, or IDL path was introduced', () => {
  const files = [
    source('./AgentFeeReadinessService.ts'),
    source('./AgentTopUpService.ts'),
    source('../components/AgentFeeCard.tsx'),
    source('./HeartbeatCoordinator.ts'),
  ].join('\n');
  assert.doesNotMatch(
    files,
    /REGISTER_SECRET|EXPO_PUBLIC_NOTIFY_SECRET|x-dmv-secret/,
  );
  assert.doesNotMatch(
    files,
    /serverPayer|keeper.*payer|beneficiary.*payer|vault.*feePayer/i,
  );
  assert.doesNotMatch(files, /rotateAgent|MigrationService|generateAgentKey/);
  assert.doesNotMatch(files, /mainnet/);
  assert.doesNotMatch(files, /setInterval|automatic.*transfer/i);
});
