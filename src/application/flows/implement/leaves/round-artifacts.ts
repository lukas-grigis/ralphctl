import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { EvaluationSignal, HarnessSignal } from '@src/domain/signal.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { SessionId } from '@src/integration/ai/providers/_engine/session-id.ts';
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
 * Read the captured Claude `session_id` from `rounds/<N>/<role>/sessionId` — the sibling text
 * file the Claude adapter writes via `persistSessionIdFile` after every spawn. Returns
 * `undefined` when the file is missing (the adapter skips the write on a spawn that never
 * reported an id — process crash, malformed stream-json, …) or empty.
 *
 * Used by the generator / evaluator leaves to thread the prior round's session into
 * `implementSession({ resume })`, keeping each role on a single conversational thread across
 * the gen-eval loop. One disk read per round — negligible overhead, and the file-based
 * provider contract is the canonical source of truth for captured ids.
 */
export const readRoundSessionId = async (
  workspaceRoot: AbsolutePath,
  round: number,
  role: 'generator' | 'evaluator'
): Promise<SessionId | undefined> => {
  const path = join(String(workspaceRoot), 'rounds', String(round), role, 'sessionId');
  let content: string;
  try {
    content = await fs.readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  const trimmed = content.trim();
  return trimmed.length === 0 ? undefined : (trimmed as SessionId);
};

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
  logger?: Logger,
  /**
   * Optional task name interpolated into the H1 of `evaluation.md` (`# Evaluation — <name>`) so
   * the rendered file is self-identifying when an operator opens it post-hoc. Omitted in tests
   * and in callers that don't have the task name handy — the H1 falls back to plain `# Evaluation`.
   */
  taskName?: string
): Promise<void> => {
  const base = roundDir(workspaceRoot, round, 'evaluator');
  const evaluation = await writeTextAtomic(
    join(base, 'evaluation.md'),
    renderEvaluation(findEvaluation(signals), taskName)
  );
  if (!evaluation.ok) {
    logger?.warn('failed to write evaluator round artifact', { round, base, error: evaluation.error.message });
  }
};

/**
 * Persist the rendered prompt the harness handed to the AI provider for a given gen-eval round
 * to `<workspaceRoot>/rounds/<N>/<role>/prompt.md`. Called from the generator + evaluator
 * leaves immediately after `buildImplementPrompt` / `buildEvaluatePrompt` resolves, BEFORE the
 * provider call — that way a post-hoc debug session can re-issue the same prompt to the model
 * (or diff it against a later round's prompt to see how the prior critique reshaped the brief)
 * without re-running the chain.
 *
 * Atomic write via `writeTextAtomic` (tmp+rename): a crash mid-write cannot leave a half-written
 * file on disk. Best-effort like the evaluator-side artifact write: a write failure is logged
 * and swallowed so the audit trail can't take down the chain.
 */
export const writeRoundPrompt = async (
  workspaceRoot: AbsolutePath,
  round: number,
  role: 'generator' | 'evaluator',
  prompt: string,
  logger?: Logger
): Promise<void> => {
  const base = roundDir(workspaceRoot, round, role);
  const wrote = await writeTextAtomic(join(base, 'prompt.md'), prompt);
  if (!wrote.ok) {
    logger?.warn('failed to write round prompt', { round, role, base, error: wrote.error.message });
  }
};

const findEvaluation = (signals: readonly HarnessSignal[]): EvaluationSignal | undefined =>
  signals.find((s): s is EvaluationSignal => s.type === 'evaluation');

/**
 * Title-case helper for dimension headings. The signal carries arbitrary lowercase strings
 * (`correctness`, `error-handling`, …) — uppercasing the first letter is good enough to read
 * as an H2 without inventing rules for hyphenated or multi-word names.
 */
const titleCase = (s: string): string => (s.length === 0 ? s : `${s[0]!.toUpperCase()}${s.slice(1)}`);

const verdictSignal = (status: EvaluationSignal['status']): string => {
  switch (status) {
    case 'passed':
      return '`<evaluation-passed>`';
    case 'failed':
      return '`<evaluation-failed>`';
    case 'malformed':
      return '_malformed — no verdict emitted_';
  }
};

/**
 * Split a dimension's `finding` string into rendered bullets. The AI typically emits multi-bullet
 * findings — either newline-separated (`- a\n- b\n- c`) or, when the AI condenses onto one line,
 * with ` - ` separators between adjacent points. We honour both so the rendered evaluation reads
 * as a clean bullet list under each H2 rather than a single run-on paragraph.
 *
 * Falls back to a single one-line bullet for findings with no detectable bullet structure —
 * preserves the content without inventing fake list items.
 */
const splitFindingBullets = (finding: string): readonly string[] => {
  const trimmed = finding.trim();
  if (trimmed.length === 0) return [];
  if (/(^|\n)\s*-\s/.test(trimmed)) {
    return trimmed
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*-\s+/, '').trim())
      .filter((line) => line.length > 0);
  }
  if (!trimmed.includes('\n') && / - /.test(trimmed)) {
    return trimmed
      .split(/ - /)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [trimmed.replace(/\s+/g, ' ')];
};

/**
 * Split the critique into bullet entries — one bullet per paragraph. The evaluator's calibration
 * examples prefix each paragraph with a `[Dimension]` tag, so paragraph boundaries (`\n\n`) are
 * the natural split point. Whitespace inside each paragraph is collapsed so a soft-wrapped entry
 * renders cleanly as one bullet.
 */
const splitCritiqueBullets = (critique: string): readonly string[] => {
  const trimmed = critique.trim();
  if (trimmed.length === 0) return [];
  return trimmed
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0);
};

const renderEvaluation = (e: EvaluationSignal | undefined, taskName?: string): string => {
  if (e === undefined) {
    return '# Evaluation\n\n_No `<evaluation-passed>` or `<evaluation-failed>` verdict emitted by the evaluator._\n';
  }
  const score = e.overallScore !== undefined ? e.overallScore.toFixed(1) : 'n/a';
  const title = taskName !== undefined && taskName.length > 0 ? `# Evaluation — ${taskName}` : '# Evaluation';
  const lines: string[] = [
    title,
    '',
    `**Status:** ${e.status} · **Overall:** ${score} / 5 · **Verdict signal:** ${verdictSignal(e.status)}`,
    '',
  ];
  if (e.dimensions.length === 0) {
    lines.push('## Dimensions', '', '_No dimensions emitted._', '');
  } else {
    for (const d of e.dimensions) {
      const verdict = d.passed ? 'passed' : 'failed';
      lines.push(`## ${titleCase(d.dimension)} — ${verdict} (${String(d.score)}/5)`, '');
      const bullets = splitFindingBullets(d.finding);
      if (bullets.length === 0) {
        lines.push('_No finding emitted._', '');
      } else {
        for (const b of bullets) lines.push(`- ${b}`);
        lines.push('');
      }
    }
  }
  const critique = e.critique?.trim();
  if (critique !== undefined && critique.length > 0) {
    lines.push('## Critique', '');
    const items = splitCritiqueBullets(critique);
    for (const item of items) lines.push(`- ${item}`);
    lines.push('');
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
};
