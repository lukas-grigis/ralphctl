import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { FULL_AUTO } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

/**
 * Per-call AiSession profile for implement and evaluate calls. The session "plugs onto" the
 * repo: the user's repo is the foundation; the harness extends it with the per-task sandbox.
 *
 *  - `repoPath` is the AI session's working directory. Claude / Copilot / Codex only
 *    auto-discover their context files (`CLAUDE.md` / `.github/copilot-instructions.md` /
 *    `AGENTS.md`), skills (`.claude/skills` / `.github/skills` / `.agents/skills`), agents,
 *    and `.mcp.json` from cwd — not from `--add-dir` roots. Putting cwd at the repo means
 *    per-repo project guidance is visible to the running AI.
 *
 *  - `sandboxCwd` is mounted as an additional root with `--add-dir`. The per-task workspace
 *    under `<sprintDir>/implement/<task-id>/` carries the harness's handoff files
 *    (`prompt.md`, `done-criteria.md`, `rounds/<N>/…/signals.json`); the AI reads / writes
 *    them via that path. Git operations (`commit-task`, `branch-preflight`, `post-task-check`)
 *    keep targeting `repoPath` — "AI cwd" and "git working tree" are now the same path.
 *
 * Harness-authored skills land in `<repo>/<parentDir>/skills/ralphctl-<name>/` (the
 * `ralphctl-` prefix is set in the bundled / project skill sources). The skills adapter
 * appends one wildcard line to `.git/info/exclude` on first install so they never show up
 * in `git status` or `git add -A`.
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
  cwd: repoPath,
  additionalRoots: [sandboxCwd],
  model,
  permissions: FULL_AUTO,
  signalsFile,
});
