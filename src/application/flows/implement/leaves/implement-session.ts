import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { FULL_AUTO } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

/**
 * Per-call AiSession profile for implement and evaluate calls. Two-tier mount layout:
 *
 *  - `sandboxCwd` is the AI session's working directory. The per-task workspace under
 *    `<sprintDir>/implement/<task-id>/` is the harness's territory — `linkSkillsLeaf` writes
 *    `.claude/skills/` here, prompt.md / done-criteria.md / rounds/N/* already live here.
 *    Putting the AI session's cwd inside the harness dir means our managed context never
 *    enters the user's repo, never shows up in `git status`, never gets `git add -A`'d into
 *    a task commit.
 *
 *  - `repoPath` is mounted as an additional root with `--add-dir`. The AI reads / edits the
 *    user's repo via that path; per-repo `.claude/skills/`, `.mcp.json`, `agents/`, and
 *    whatever else lives there is reachable on top of the harness-linked context. Git
 *    operations (`commit-task`, `branch-preflight`, `post-task-check`) keep targeting this
 *    path — "AI cwd" and "git working tree" are separate concepts.
 *
 * Both calls run full-auto; the harness's branch / dirty-tree / post-task-check layer is the
 * safety gate, not Claude's per-tool prompts.
 */
export const implementSession = (
  sandboxCwd: AbsolutePath,
  repoPath: AbsolutePath,
  prompt: Prompt,
  model: string,
  signalsFile: AbsolutePath
): AiSession => ({
  prompt,
  cwd: sandboxCwd,
  additionalRoots: [repoPath],
  model,
  permissions: FULL_AUTO,
  signalsFile,
});
