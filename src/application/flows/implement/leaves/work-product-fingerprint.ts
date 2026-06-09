import { createHash } from 'node:crypto';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';

/**
 * Content fingerprint of the working tree's uncommitted changes — the work-product signal the
 * plateau predicate uses instead of the generator's reworded commit subject.
 *
 * Hashed inputs (in order):
 *   - `git status --porcelain` — captures staged AND untracked files, including new files whose
 *     content the diff below would otherwise miss.
 *   - `git diff HEAD` — the actual content of every tracked change.
 *
 * Deliberately NOT `git diff --stat`: stat output omits staged/untracked files and collides on
 * any two diffs with the same per-file line counts, so two materially different edits could
 * share a fingerprint. The full porcelain + content diff distinguishes them.
 *
 * Stable within an attempt: the harness commits once per attempt AFTER the gen-eval loop exits,
 * so intra-loop diffs are all against the same HEAD — identical fingerprints across rounds mean
 * the AI genuinely changed nothing, which is exactly the plateau the predicate should fire on.
 *
 * Best-effort: any git failure returns `undefined` so the plateau predicate degrades to its
 * commit-subject fallback rather than crashing the loop. The fingerprint is an exemption input,
 * never a correctness gate.
 */
export const computeWorkProductFingerprint = async (
  gitRunner: GitRunner,
  cwd: AbsolutePath
): Promise<string | undefined> => {
  const status = await gitRunner.run(cwd, ['status', '--porcelain']);
  if (!status.ok || status.value.exitCode !== 0) return undefined;

  const diff = await gitRunner.run(cwd, ['diff', 'HEAD']);
  if (!diff.ok || diff.value.exitCode !== 0) return undefined;

  return createHash('sha1').update(status.value.stdout).update('\0').update(diff.value.stdout).digest('hex');
};
