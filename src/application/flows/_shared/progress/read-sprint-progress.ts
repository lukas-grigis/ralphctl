import { dirname, join } from 'node:path';
import { promises as fs } from 'node:fs';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { capProgressBody, progressCapBudgetForModel } from '@src/application/flows/_shared/progress/cap-progress.ts';

/**
 * Read `<sprintDir>/progress.md` for the inline `## Prior progress` section (audit-[07]), CAPPED to
 * the same token budget the implement gen-eval loop uses so a long sprint's journal doesn't blow up
 * the planning-prompt token cost. There is no "current task" in planning, so only the recent-siblings
 * bound applies; short journals pass through unchanged. Shared by every planning flow — plan, ideate,
 * and refine each nest their unit root exactly one level under the sprint dir (`<sprintDir>/plan/
 * <run-slug>/`, `<sprintDir>/ideate/<run-slug>/`, `<sprintDir>/refinement/<ticket-slug>/`), so the
 * sprint dir is always the parent of the supplied unit root. Best-effort: missing or unreadable
 * degrades to empty string.
 *
 * @public
 */
export const readCappedSprintProgress = async (unitRoot: AbsolutePath, model: string): Promise<string> => {
  const sprintDir = dirname(String(unitRoot));
  try {
    const raw = await fs.readFile(join(sprintDir, 'progress.md'), 'utf8');
    return capProgressBody(raw, { recentBudgetTokens: progressCapBudgetForModel(model) });
  } catch {
    return '';
  }
};
