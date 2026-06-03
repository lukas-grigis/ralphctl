import { dirname } from 'node:path';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { SessionId } from '@src/integration/ai/providers/_engine/session-id.ts';
import { FULL_AUTO } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import { currentSessionId } from '@src/application/session/session.ts';

/**
 * Per-call AiSession profile for implement and evaluate calls. The session "plugs onto" the
 * repo: the user's repo is the foundation; the harness extends it with the per-task sandbox
 * AND the wider sprint directory.
 *
 *  - `repoPath` is the AI session's working directory. Claude / Copilot / Codex only
 *    auto-discover their context files (`CLAUDE.md` / `.github/copilot-instructions.md` /
 *    `AGENTS.md`), skills (`.claude/skills` / `.github/skills` / `.agents/skills`), agents,
 *    and `.mcp.json` from cwd — not from `--add-dir` roots. Putting cwd at the repo means
 *    per-repo project guidance is visible to the running AI.
 *
 *  - `sandboxCwd` is mounted as an additional root with `--add-dir`. The per-task workspace
 *    under `<sprintDir>/implement/<task-id>/` carries the harness's handoff files
 *    (`prompt.md`, `rounds/<N>/…/signals.json`); the AI reads / writes them via that path.
 *    Git operations (`commit-task`, `branch-preflight`, `post-task-verify`) keep targeting
 *    `repoPath` — "AI cwd" and "git working tree" are now the same path.
 *
 *  - `sprintDir` is mounted as a SECOND additional root so the AI can read sprint-wide
 *    artifacts the sandbox doesn't contain — primarily `<sprintDir>/progress.md`, which the
 *    audit-[09] contract expects every implement spawn to consult. The sandbox is nested
 *    UNDER `sprintDir`, but adapters declare additional roots non-recursively; mounting
 *    `sprintDir` explicitly is the only way to surface its sibling files. Refine / plan /
 *    ideate / readiness already cwd inside `<sprintDir>/<flow>/<unit-slug>/` and reach
 *    progress.md via cwd-relative traversal — only implement (cwd = repo) needs this.
 *
 * Harness-authored skills land in `<repo>/<parentDir>/skills/ralphctl-<name>/` (the
 * `ralphctl-` prefix is set in the bundled / project skill sources). The skills adapter
 * appends one wildcard line to `.git/info/exclude` on first install so they never show up
 * in `git status` or `git add -A`.
 *
 * Both calls run full-auto; the harness's branch / dirty-tree / post-task-verify layer is the
 * safety gate, not Claude's per-tool prompts.
 *
 * `resume` carries the captured `session_id` from a prior spawn of the SAME role for the SAME
 * task — generator resumes generator, evaluator resumes evaluator. When set, the Claude adapter
 * forwards it as `--resume <id>` (`claude/headless.ts`) so the model continues a single
 * conversational thread across the gen-eval loop's rounds instead of cold-starting on every
 * spawn. The launcher / per-task chain is responsible for clearing the slot at task boundaries
 * so a new task gets a fresh thread.
 */
export const implementSession = (
  sandboxCwd: AbsolutePath,
  repoPath: AbsolutePath,
  sprintDir: AbsolutePath,
  prompt: Prompt,
  model: string,
  signalsFile: AbsolutePath,
  role: 'generator' | 'evaluator',
  resume?: SessionId,
  effort?: string,
  abortSignal?: AbortSignal
): AiSession => {
  // The per-round output dir is the directory containing `signalsFile` (e.g.
  // `<sandboxCwd>/rounds/<N>/<role>/`). Stamping it on the session lets every adapter's
  // `resolveWritableRoots` auto-mount it as a `--add-dir` writable root, matching the
  // audit-[09] migration every other flow (review, detect-skills, readiness, …) already
  // adopted. Without this, codex's `workspace-write` sandbox refused the AI's Write call
  // for `signals.json` in the per-round dir, leaving the file absent and the leaf failing
  // with `signals-missing`.
  const outputDir = AbsolutePath.parse(dirname(String(signalsFile)));
  // Read the chain/runner session id HERE — this helper is invoked from inside the
  // generator/evaluator leaf's `execute(...)`, which the runner wraps in `runWithSession`,
  // so `currentSessionId()` returns the active runner id. Threaded onto the session as DATA
  // so the headless adapter can stamp it onto the token-usage event WITHOUT importing the
  // application session helper across the layer boundary. Undefined when no session scope is
  // active (e.g. a direct unit-test call) → the spread below omits the field.
  const chainSessionId = currentSessionId();
  return {
    prompt,
    cwd: repoPath,
    additionalRoots: [sandboxCwd, sprintDir],
    model,
    permissions: FULL_AUTO,
    signalsFile,
    role,
    ...(chainSessionId !== undefined ? { chainSessionId } : {}),
    ...(outputDir.ok ? { outputDir: outputDir.value } : {}),
    ...(resume !== undefined ? { resume } : {}),
    ...(effort !== undefined ? { effort } : {}),
    // Caller-controlled abort (TUI cancel / Ctrl-C). Threaded from the leaf framework's
    // `execute(input, signal)` second argument so the headless provider's SIGTERM→SIGKILL
    // kill ladder, abort-aware exit classification, and cancellable rate-limit sleep all
    // observe a user cancel mid-spawn. Without this the field is undefined and that whole
    // machinery is dead code — a manual abort would let the child run to natural completion,
    // stranding the repo lock and the progress spinner until the run ends on its own.
    ...(abortSignal !== undefined ? { abortSignal } : {}),
  };
};
