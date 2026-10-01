import type { Task } from '@src/domain/entity/task.ts';

/** The newest generator round of a task that recorded a provider session id. */
export interface RecordedGeneratorRound {
  readonly roundN: number;
  readonly attemptN: number;
  readonly sessionId: string;
  readonly provider: string;
  readonly model: string;
  /** Absent on rounds stamped before the cwd was recorded — never resumable. */
  readonly cwd?: string;
}

/** Port: read the newest generator round with a session id, or `undefined` when there is none. */
export type FindLastGeneratorRound = () => Promise<RecordedGeneratorRound | undefined>;

/** What the resumed spawn would run with; a recorded round must match all three. */
export interface CrashResumeTarget {
  readonly provider: string;
  readonly model: string;
  readonly cwd: string;
}

export interface CrashResumeLookup {
  readonly findLastGeneratorRound: FindLastGeneratorRound;
  readonly target: CrashResumeTarget;
}

export type CrashResumeDecision =
  | { readonly kind: 'resume'; readonly sessionId: string; readonly roundN: number }
  | { readonly kind: 'cold'; readonly reason: string };

/**
 * Attempts whose work the interrupted attempt still carries: itself, plus each predecessor it was
 * opened to resume after a harness interruption (a resume that crashed before its first round).
 */
const interruptedLineage = (task: Task, interruptedAttemptN: number): ReadonlySet<number> => {
  const lineage = new Set<number>();
  let n: number | undefined = interruptedAttemptN;
  while (n !== undefined && !lineage.has(n)) {
    lineage.add(n);
    const recovering = task.attempts.find((a) => a.n === n)?.recovering;
    n = recovering?.cause === 'harness-interrupted' ? recovering.fromAttemptN : undefined;
  }
  return lineage;
};

/**
 * Decide whether an interrupted attempt's generator thread can be resumed. A provider session is
 * only meaningful to the same provider, model and working directory (Claude keys its transcripts
 * by cwd), so any mismatch — or a round from an unrelated earlier attempt — starts cold.
 */
export const decideCrashResume = (
  task: Task,
  interruptedAttemptN: number,
  round: RecordedGeneratorRound | undefined,
  target: CrashResumeTarget
): CrashResumeDecision => {
  if (round === undefined) return { kind: 'cold', reason: 'no generator session recorded' };
  if (!interruptedLineage(task, interruptedAttemptN).has(round.attemptN)) {
    return { kind: 'cold', reason: `last recorded session belongs to settled attempt ${String(round.attemptN)}` };
  }
  if (round.provider !== target.provider) {
    return { kind: 'cold', reason: `provider changed (${round.provider} → ${target.provider})` };
  }
  if (round.model !== target.model) return { kind: 'cold', reason: `model changed (${round.model} → ${target.model})` };
  if (round.cwd !== target.cwd) return { kind: 'cold', reason: 'working directory changed' };
  return { kind: 'resume', sessionId: round.sessionId, roundN: round.roundN };
};
