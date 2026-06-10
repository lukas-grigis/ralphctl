import { createHash } from 'node:crypto';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';

/**
 * Content fingerprint of the working tree's uncommitted changes — the work-product signal the
 * plateau predicate uses instead of the generator's reworded commit subject.
 *
 * Hashed inputs (in order):
 *   - `git status --porcelain` — the tree's shape: which paths are staged / modified / untracked.
 *   - `git diff HEAD` — the actual content of every tracked change.
 *   - the blob hashes of every UNTRACKED file (`git ls-files --others --exclude-standard` →
 *     `git hash-object`) — porcelain lists untracked files by NAME only and `diff HEAD` excludes
 *     their content entirely, yet within one attempt the harness commits only after the gen-eval
 *     loop exits, so a task whose deliverable is a NEW file evolves exclusively in untracked
 *     content. Without these hashes, rounds that rewrite only a new file would fingerprint
 *     identically and the plateau predicate's central exemption would never soften — a false
 *     plateau on the most ordinary task shape. The file list comes from `ls-files`, NOT from
 *     parsing porcelain (which collapses an untracked directory to one `?? dir/` line).
 *
 * Deliberately NOT `git diff --stat`: stat output omits staged/untracked files and collides on
 * any two diffs with the same per-file line counts, so two materially different edits could
 * share a fingerprint. The full porcelain + content diff + untracked blob hashes distinguish them.
 *
 * Stable within an attempt: the harness commits once per attempt AFTER the gen-eval loop exits,
 * so intra-loop diffs are all against the same HEAD — identical fingerprints across rounds mean
 * the AI genuinely changed nothing, which is exactly the plateau the predicate should fire on.
 *
 * Best-effort: any git failure returns `undefined`. NOTE the consumer-side contract this implies:
 * `workProductChanged` in `plateau-detection.ts` treats a missing fingerprint conservatively (no
 * exemption when prior rounds carry fingerprints) rather than falling back to the gameable
 * commit-subject proxy — see the either-side rule documented there. The fingerprint is an
 * exemption input, never a correctness gate.
 */
export const computeWorkProductFingerprint = async (
  gitRunner: GitRunner,
  cwd: AbsolutePath
): Promise<string | undefined> => {
  const status = await gitRunner.run(cwd, ['status', '--porcelain']);
  if (!status.ok || status.value.exitCode !== 0) return undefined;

  const diff = await gitRunner.run(cwd, ['diff', 'HEAD']);
  if (!diff.ok || diff.value.exitCode !== 0) return undefined;

  const hash = createHash('sha1').update(status.value.stdout).update('\0').update(diff.value.stdout);

  // Untracked content: list real file paths (never porcelain's collapsed `?? dir/` form), then
  // let git hash their contents in one batch. An empty list is the common case and skips the
  // second spawn entirely.
  const untracked = await gitRunner.run(cwd, ['ls-files', '--others', '--exclude-standard']);
  if (!untracked.ok || untracked.value.exitCode !== 0) return undefined;
  const paths = untracked.value.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (paths.length > 0) {
    const blobs = await gitRunner.run(cwd, ['hash-object', '--', ...paths]);
    if (!blobs.ok || blobs.value.exitCode !== 0) return undefined;
    hash.update('\0').update(blobs.value.stdout);
  }

  return hash.digest('hex');
};
