import { join } from 'node:path';
import type { EvaluationSignal, HarnessSignal } from '@src/domain/signal.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { listDir, writeTextAtomic } from '@src/integration/io/fs.ts';

/**
 * Per-task on-disk audit trail at `<sprintDir>/implement/<task-id>/rounds/<N>/{generator,
 * evaluator}/`. Each gen-eval round emits a fixed file set so the run can be replayed offline:
 *
 *   - `signals.json` — the structured signals the AI emitted, written **by the provider**
 *     (caller-supplied `session.signalsFile = roundSignalsPath(...)` on each `generate(...)`
 *     call). This is the canonical artifact.
 *   - `evaluation.md` — rendered evaluator verdict; written here by
 *     {@link writeEvaluatorRoundArtifacts}.
 *
 * The pre-refactor `session.md` (raw AI prose) is gone — the prose is no longer a first-class
 * artifact (REQ-6). If postmortem debugging needs it, the provider could grow a `--keep-prose`
 * opt-in later.
 *
 * Round numbering: `nextRoundNum` returns `max(existing-rounds-on-disk) + 1`. On a fresh task
 * this collapses to `1, 2, 3, …` and matches `ctx.genEvalTurn`; on a resumed run (the ctx turn
 * counter starts at 0 again) it picks up after the highest round already on disk so prior turns
 * are never overwritten.
 *
 * Single-writer contract: `nextRoundNum` reads the disk and adds one — two concurrent callers
 * would compute the same N and clobber each other's `rounds/<N>/`. Safe in the implement chain
 * because per-task sub-chains are sequential within one process AND the chain holds a
 * per-worktree advisory lock against other ralphctl runs (see `withRepoLock`). Don't reuse this
 * helper outside that ordering without adding a lock.
 *
 * Writes are best-effort: failures are logged and swallowed so the audit trail can't take down
 * the chain.
 */

export const nextRoundNum = async (workspaceRoot: AbsolutePath): Promise<number> => {
  const entries = await listDir(join(String(workspaceRoot), 'rounds'));
  if (!entries.ok) return 1;
  let max = 0;
  for (const name of entries.value) {
    const n = Number.parseInt(name, 10);
    if (Number.isInteger(n) && String(n) === name && n > max) max = n;
  }
  return max + 1;
};

/**
 * Absolute path to `rounds/<N>/<role>/signals.json` for the given workspace + round + role.
 * Used by the generator / evaluator leaves to thread `session.signalsFile` into the provider
 * call so the structured-output artifact lands directly in the audit tree.
 */
export const roundSignalsPath = (workspaceRoot: AbsolutePath, round: number, role: 'generator' | 'evaluator'): string =>
  join(String(workspaceRoot), 'rounds', String(round), role, 'signals.json');

/**
 * Workspace-relative path to `rounds/<N>/evaluator/evaluation.md`. Stamped on the recorded
 * `Evaluation` so operators can navigate from `tasks.json` straight to the verdict.
 */
export const roundEvaluationRelativePath = (round: number): string =>
  join('rounds', String(round), 'evaluator', 'evaluation.md');

const roundDir = (workspaceRoot: AbsolutePath, round: number, role: 'generator' | 'evaluator'): string =>
  join(String(workspaceRoot), 'rounds', String(round), role);

export const writeEvaluatorRoundArtifacts = async (
  workspaceRoot: AbsolutePath,
  round: number,
  signals: readonly HarnessSignal[],
  logger?: Logger
): Promise<void> => {
  const base = roundDir(workspaceRoot, round, 'evaluator');
  const evaluation = await writeTextAtomic(join(base, 'evaluation.md'), renderEvaluation(findEvaluation(signals)));
  if (!evaluation.ok) {
    logger?.warn('failed to write evaluator round artifact', { round, base, error: evaluation.error.message });
  }
};

const findEvaluation = (signals: readonly HarnessSignal[]): EvaluationSignal | undefined =>
  signals.find((s): s is EvaluationSignal => s.type === 'evaluation');

const renderEvaluation = (e: EvaluationSignal | undefined): string => {
  if (e === undefined) {
    return '# Evaluation\n\n_No `<evaluation-passed>` or `<evaluation-failed>` verdict emitted by the evaluator._\n';
  }
  const score = e.overallScore !== undefined ? e.overallScore.toFixed(1) : 'n/a';
  const lines: string[] = [
    '# Evaluation',
    '',
    `- **Status:** ${e.status}`,
    `- **Overall score:** ${score}`,
    '',
    '## Dimensions',
    '',
  ];
  if (e.dimensions.length === 0) {
    lines.push('_No dimensions._');
  } else {
    for (const d of e.dimensions) {
      const verdict = d.passed ? 'passed' : 'failed';
      lines.push(`- **${d.dimension}** (${String(d.score)}/5, ${verdict}): ${d.finding}`);
    }
  }
  const critique = e.critique?.trim();
  if (critique !== undefined && critique.length > 0) {
    lines.push('', '## Critique', '', critique);
  }
  lines.push('');
  return lines.join('\n');
};
