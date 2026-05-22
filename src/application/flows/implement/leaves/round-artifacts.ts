import { promises as fs } from 'node:fs';
import { join } from 'node:path';
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
 *   - `evaluation.md` — rendered evaluator verdict, written by `renderSidecars` against the
 *     evaluator leaf's audit-[09] contract (`evaluatorOutputContract.sidecars`). The leaf
 *     itself never writes the file; the harness derives it post-validation from the single
 *     `evaluation` signal in `signals.json`.
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

/**
 * Persist the rendered prompt the harness handed to the AI provider for a given gen-eval round
 * to `<workspaceRoot>/rounds/<N>/<role>/prompt.md`. Called from the generator + evaluator
 * leaves immediately after `buildImplementPrompt` / `buildEvaluatePrompt` resolves, BEFORE the
 * provider call — that way a post-hoc debug session can re-issue the same prompt to the model
 * (or diff it against a later round's prompt to see how the prior critique reshaped the brief)
 * without re-running the chain.
 *
 * Atomic write via `writeTextAtomic` (tmp+rename): a crash mid-write cannot leave a half-written
 * file on disk. Best-effort: a write failure is logged and swallowed so the audit trail can't
 * take down the chain.
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
