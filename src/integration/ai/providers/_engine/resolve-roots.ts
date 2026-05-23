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
export const resolveWritableRoots = (session: AiSession): readonly AbsolutePath[] => {
  const declared = session.additionalRoots ?? [];
  if (session.outputDir === undefined) return declared;
  const cwdStr = String(session.cwd);
  const outputStr = String(session.outputDir);
  if (outputStr === cwdStr) return declared;
  if (declared.some((r) => String(r) === outputStr)) return declared;
  return [...declared, session.outputDir];
};
