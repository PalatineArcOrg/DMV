import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getDeadlineStageDurations,
  toNotificationStageDurations,
} from '../utils/deadlineStageConfig.ts';

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

test('demo and production stage configuration is deterministic and shared with notification registration', () => {
  const configured = {
    stage1Duration: 10,
    stage2Duration: 20,
    stage3Duration: 30,
  };
  assert.deepEqual(
    getDeadlineStageDurations(false, configured),
    configured,
  );
  assert.deepEqual(getDeadlineStageDurations(true, configured), {
    stage1Duration: 30,
    stage2Duration: 30,
    stage3Duration: 30,
  });
  assert.deepEqual(
    toNotificationStageDurations(configured),
    { stage1: 10, stage2: 20, stage3: 30 },
  );

  const configSource = source('../utils/deadlineStageConfig.ts');
  const settings = source('../screens/SettingsScreen.tsx');
  const setup = source('../screens/EstateReviewScreen.tsx');
  assert.doesNotMatch(configSource, /__DEV__/);
  assert.match(settings, /getDeadlineStageDurations/);
  assert.match(settings, /toNotificationStageDurations/);
  assert.match(setup, /getDeadlineStageDurations/);
  assert.doesNotMatch(
    settings,
    /__DEV__\s*\|\|\s*isDemoMode/,
  );
});

test('local history is retained for diagnostics but has no deadline or execution authority', () => {
  const history = source('./HeartbeatService.ts');
  const escalation = source('./EscalationService.ts');
  const hook = source('../hooks/useHeartbeat.ts');
  const dashboard = source('../screens/DashboardScreen.tsx');

  assert.match(history, /getLocalHistoryStatus/);
  assert.match(history, /non-authoritative history row only/);
  assert.doesNotMatch(escalation, /HeartbeatService|heartbeatRepo/);
  assert.doesNotMatch(hook, /getLocalHistoryStatus|\.getStatus\(/);
  assert.doesNotMatch(
    dashboard,
    /heartbeatStatus|heartbeatData|timeAgo\(/,
  );
  assert.match(dashboard, /authoritativeSnapshot/);
});

test('deadline lifecycle refreshes are bounded, cleaned up, and identity scoped', () => {
  const hook = source('../hooks/useHeartbeat.ts');
  const dashboard = source('../screens/DashboardScreen.tsx');

  assert.match(hook, /void refreshAuthoritativeDeadline\(\)/);
  assert.match(hook, /AppState\.addEventListener/);
  assert.match(hook, /state === 'active'/);
  // Cadence is now adaptive (deadlineRefreshPlan) rather than a fixed 30s interval,
  // so the literal is gone. The INTENT this guarded — refreshes are bounded and never
  // free-running — is asserted instead: a plan is consulted, and the tightest bound
  // is still the original 30s for a near deadline.
  assert.match(hook, /deadlineRefreshPlan\(/);
  assert.match(hook, /scheduleRefresh/);
  assert.match(hook, /clearTimeout\(refreshTimer\)/);
  assert.match(hook, /clearInterval\(projectionTimer\)/);
  assert.match(hook, /appStateSubscription\.remove\(\)/);
  assert.match(hook, /ownerRef\.current\?\.toBase58\(\)/);
  assert.match(dashboard, /useFocusEffect/);
  assert.match(
    dashboard,
    /void refreshAuthoritativeDeadline\(\)/,
  );
});

test('confirmed and reconciled heartbeats refresh canonical deadline state', () => {
  const coordinator = source('./HeartbeatCoordinator.ts');
  const reconciler = source('./HeartbeatOperationReconciler.ts');
  const dashboard = source('../screens/DashboardScreen.tsx');

  assert.match(coordinator, /await dependencies\.refreshAuthoritativeDeadline/);
  assert.match(reconciler, /await dependencies\.refreshAuthoritativeDeadline/);
  assert.match(
    dashboard,
    /refreshAuthoritativeDeadline,\s*reloadVaultState/,
  );
  assert.doesNotMatch(
    coordinator,
    /resetLocalEscalation|HeartbeatService/,
  );
  assert.doesNotMatch(reconciler, /resetLocalEscalation/);
});

test('projected or stale state has no path to the Stage 4 execution callback', () => {
  const hook = source('../hooks/useHeartbeat.ts');
  const escalation = source('./EscalationService.ts');
  const execution = source('./ExecutionService.ts');

  assert.match(hook, /stage4_refresh_required/);
  assert.match(hook, /void refreshAuthoritativeDeadline\(\)/);
  assert.match(escalation, /snapshot\.stage === 4/);
  assert.match(
    escalation,
    /snapshot\.stage !== 4 \|\|\s*!snapshot\.executableByTime/,
  );
  assert.doesNotMatch(execution, /waitForOnChainDeadline/);
  assert.doesNotMatch(execution, /Date\.now/);
});

test('deadline work remains separate from notification registration and local fallback delivery', () => {
  const hook = source('../hooks/useHeartbeat.ts');
  const deadline = source('./OnChainDeadlineService.ts');
  const escalation = source('./EscalationService.ts');

  assert.doesNotMatch(
    hook,
    /PushRegistrationService|attemptSignedRegistration|signMessage|successKey|getSetting/,
  );
  assert.doesNotMatch(
    deadline,
    /Notification|deviceToken|registration|Date\.now/,
  );
  assert.doesNotMatch(
    escalation,
    /Notification|scheduleBackgroundTimeline|sendHeartbeatReminder|sendUrgentReminder|sendFinalWarning/,
  );
  assert.match(
    hook,
    /Stage 1–3 pushes are notify-server-only and no local fallback is armed/,
  );
});

test('Dashboard distinguishes deadline authority failures without claiming local health', () => {
  const dashboard = source('../screens/DashboardScreen.tsx');
  assert.match(
    dashboard,
    /Checking the current on-chain deadline…/,
  );
  assert.match(
    dashboard,
    /last verified state is shown as stale; no execution action was started/,
  );
  assert.match(
    dashboard,
    /on-chain heartbeat state could not be validated/,
  );
  assert.match(
    dashboard,
    /warning-stage configuration does not match the vault’s on-chain grace period/,
  );
  assert.match(dashboard, /execution was not inferred/);
  assert.doesNotMatch(
    dashboard,
    /executionStarted\)[\s\S]{0,120}setExecutionCompleted\(true\)/,
  );
  assert.doesNotMatch(
    dashboard,
    /recordNonAuthoritativeLocalHeartbeat|confirmLocalHeartbeat/,
  );
});

test('on-chain activity monitoring remains opt-in history only', () => {
  const history = source('./HeartbeatService.ts');
  assert.match(
    history,
    /methods\.includes\('on_chain_activity'\)/,
  );
  assert.match(
    history,
    /recordNonAuthoritativeActivityHeartbeat/,
  );
  assert.doesNotMatch(
    history,
    /recordHeartbeatOnChain|sendRawTransaction/,
  );
});
