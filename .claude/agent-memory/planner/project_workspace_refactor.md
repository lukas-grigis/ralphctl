---
name: workspace_sandbox_refactor
description: Workspace sandbox refactor — refine/plan move into sprint-dir workspaces, evaluator gets full on-disk contract pack; decisions locked May 2026
type: project
---

Refactor planned 2026-05-03: move refine/plan AI sessions out of the user's real repos and into per-phase sandbox
workspaces under the sprint dir. Evaluator gets a full contract pack (requirements, plan, dimensions, project context).

**Why:** plan-flow.ts:285-290 sets cwd = repos[0], polluting the user's working tree with .claude/skills/. Refine has
same shape. Evaluator grades blind without upstream context.

**How to apply:** When planning work on chains/refine, chains/plan, or the evaluate loop, always anchor to the workspace
paths, never the user's repo path for the AI cwd. Execute cwd (task.projectPath) is intentionally preserved.

Key decisions locked:

- Refine cwd = sprintDir/workspaces/refine/ (drop opts.cwd from refine entirely)
- Plan cwd = sprintDir/workspaces/plan/ (kill repos[0] fallback; real repos via --add-dir for Claude, mirrored into
  workspace for Copilot)
- Evaluate cwd = task.projectPath (unchanged); workspace mounted via --add-dir for Claude; Copilot mirrors
  task.projectPath into workspace/repo/
- Workspaces are durable — never auto-deleted
- Each workspace gets a provider-native context file (CLAUDE.md or .github/copilot-instructions.md)
- Evaluate workspace built once per per-task chain; refreshed (task.md, tasks.md, tasks.json, project-context.md,
  evaluations/) before each evaluator round in the fix loop
- Port goes in business/ports/workspace-builder-port.ts; adapter in integration/persistence/workspace-builder.ts; leaves
  in application/chains/leaves/
