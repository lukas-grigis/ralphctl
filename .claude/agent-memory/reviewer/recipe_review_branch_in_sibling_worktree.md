---
name: recipe_review_branch_in_sibling_worktree
description: How to run the gate for a branch checked out in a sibling worktree when pnpm refuses the Node engine
metadata:
  type: feedback
---

`git worktree list` shows where a refactor branch lives (`.claude/worktrees/<name>`); read files there instead of
`git show`, and run the gate from that directory. `pnpm <script>` fails on a Node 22 sandbox (engines.node >= 24)
before running anything, so call the tools directly: `npx tsc --noEmit`, `npx eslint --max-warnings 0 <files>`,
`npx prettier --check <files>`, `npx knip`, `npx vitest run <dirs>`. Build the changed-file list with
`git diff --name-only --diff-filter=AM <base>..HEAD -- src tests` piped through `xargs -0`. A scratch tsx probe
must be copied into the worktree root to resolve `@src/` aliases; delete it afterwards (never leave the tree dirty).
The ui + e2e vitest subset (~2000 tests) takes ~6 minutes.
