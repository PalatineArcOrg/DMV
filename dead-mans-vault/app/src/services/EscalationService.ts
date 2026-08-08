import type { AuthoritativeDeadlineSnapshot } from './OnChainDeadlineService';
import type { EscalationStage } from '../types';

export interface EscalationStateSink {
  getStage: () => EscalationStage;
  resetNonTerminal: () => void;
  setStage: (
    stage: EscalationStage,
    observedChainTime: number,
  ) => void;
  setExecutionDeadline: (deadline: number) => void;
  setExecutionStarted: (started: boolean) => void;
}

export interface EscalationServiceDependencies {
  state: EscalationStateSink;
}

type ExecutionCallback = (
  snapshot: AuthoritativeDeadlineSnapshot,
) => void | Promise<void>;

// Process-lifetime guard: recreating a hook/service instance must not crank the
// same verified vault deadline twice. The on-chain instructions and independent
// keepers remain idempotent; this guard only constrains the mobile callback.
const attemptedExecutionDeadlines = new Set<string>();

function snapshotIdentity(
  snapshot: AuthoritativeDeadlineSnapshot,
): string {
  return [
    snapshot.cluster,
    snapshot.programId,
    snapshot.owner.toBase58(),
    snapshot.vault.toBase58(),
    String(snapshot.finalDeadline),
  ].join('/');
}

export class EscalationService {
  private readonly state: EscalationStateSink;
  private currentStage: EscalationStage;
  private currentIdentity: string | null = null;
  private executionCallback: ExecutionCallback | null = null;

  constructor(dependencies: EscalationServiceDependencies) {
    this.state = dependencies.state;
    this.currentStage = this.state.getStage();
  }

  setExecutionCallback(callback: ExecutionCallback): void {
    this.executionCallback = callback;
  }

  /**
   * Applies only a freshly RPC-verified snapshot. Projected or local-history
   * state has no entry point capable of reaching the execution callback.
   */
  applyAuthoritativeSnapshot(
    snapshot: AuthoritativeDeadlineSnapshot,
  ): void {
    const identity = snapshotIdentity(snapshot);
    const identityChanged =
      this.currentIdentity !== null &&
      this.currentIdentity !== identity;
    if (identityChanged || snapshot.stage === 0) {
      this.state.resetNonTerminal();
      this.currentStage = 0;
    }
    // An active, unexecuted vault with a verified healthy deadline has no
    // terminal execution evidence to preserve. Stage 0 clears stale crank UI.
    this.currentIdentity = identity;

    this.currentStage = snapshot.stage;
    this.state.setStage(snapshot.stage, snapshot.chainUnixTime);
    this.state.setExecutionDeadline(snapshot.finalDeadline);

    if (
      snapshot.stage !== 4 ||
      !snapshot.executableByTime ||
      attemptedExecutionDeadlines.has(identity)
    ) {
      return;
    }

    // Mark attempted before invoking user code. A callback rejection must not
    // create an immediate retry loop; keepers/notify-server remain independent.
    attemptedExecutionDeadlines.add(identity);
    this.state.setExecutionStarted(true);
    if (this.executionCallback) {
      Promise.resolve(this.executionCallback(snapshot)).catch(() => {
        // Callback failure does not falsify the verified on-chain deadline.
      });
    }
  }

  /**
   * A bounded monotonic projection may update warning UI through stages 0–3.
   * It can never enter Stage 4 or invoke execution.
   */
  applyProjectedSnapshot(
    snapshot: AuthoritativeDeadlineSnapshot,
  ): void {
    if (snapshot.stage === 4 || snapshot.executableByTime) return;
    this.currentStage = snapshot.stage;
    this.state.setStage(snapshot.stage, snapshot.chainUnixTime);
    this.state.setExecutionDeadline(snapshot.finalDeadline);
  }

  /**
   * Unavailable/stale state preserves the last verified stage. It deliberately
   * cannot advance a stage or invoke execution.
   */
  markAuthorityUnavailable(): void {
    // The hook publishes the stale/unknown UI state while this service keeps
    // the last verified stage intact.
  }

  resetForIdentityChange(): void {
    this.currentIdentity = null;
    this.currentStage = 0;
    this.state.resetNonTerminal();
  }

  getCurrentStage(): EscalationStage {
    return this.currentStage;
  }
}

export function clearExecutionAttemptGuardsForTests(): void {
  attemptedExecutionDeadlines.clear();
}
