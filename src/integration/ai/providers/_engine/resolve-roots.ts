import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';

/**
 * Compute the full list of writable roots an adapter must surface to its underlying CLI
 * (via `--add-dir` or equivalent). The set is:
 *
 *  1. Every entry in `session.additionalRoots` (in declared order).
 *  2. `session.outputDir`, when set and not equal to `cwd` and not already in `additionalRoots`.
 *
 * Why auto-include `outputDir`: the audit-[09] contract requires the AI to land
 * `signals.json` inside `outputDir` via its Write tool. Every adapter constrains writes to
 * `cwd + --add-dir paths` (Claude/Copilot via flag, Codex via workspace-write sandbox), so
 * an `outputDir` outside cwd must be mounted or the spawn fails with "no permission to write
 * to <outputDir>/signals.json". Centralising this here keeps each leaf from having to
 * remember to thread outputDir into additionalRoots manually.
 *
 * De-duplication is by exact string equality on the `AbsolutePath` brand. Order is
 * preserved: caller-declared roots first, outputDir last when it adds new value.
 */
export const resolveWritableRoots = (session: AiSession): readonly AbsolutePath[] =>
  appendRoot(session.additionalRoots ?? [], session.outputDir, String(session.cwd));

/**
 * Append one more root unless it adds nothing — it is `cwd` (implicitly mounted) or already
 * declared. Exported because an adapter can have a root of its own to mount that the session does
 * not know about: copilot headless writes the prompt file the CLI is pointed at, and that
 * directory has to be readable. Keeping the "worth mounting" rule in one place stops each such
 * adapter from open-coding its own copy.
 *
 * @public
 */
export const appendRoot = (
  roots: readonly AbsolutePath[],
  candidate: AbsolutePath | undefined,
  cwd: string
): readonly AbsolutePath[] => {
  if (candidate === undefined) return roots;
  const value = String(candidate);
  if (value === cwd || roots.some((r) => String(r) === value)) return roots;
  return [...roots, candidate];
};
