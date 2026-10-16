---
name: worktree-isolation-command-filter
description: In a worktree-isolated workflow run, Bash refuses any compound command, heredoc or inline script whose text mentions git — even inside a doc string being edited
metadata:
  type: feedback
---

When the agent runs isolated in a workflow worktree, the sandbox refuses a Bash command it cannot
prove stays inside the worktree: a heredoc or `python3 - <<EOF` whose body contains the word "git"
(a doc sentence about `git cherry-pick` is enough), a pipeline that feeds `git status` output into
another command, or a long `&&` chain mixing git with other tools.

**Why:** the filter pattern-matches git usage in the command text, not what actually executes.

**How to apply:** write multi-line edit scripts to the scratchpad with the Write tool and run them as
`python3 <abs-path>`; run git as plain single commands (`git status --short`, then `git add <paths>`,
then `git commit …`) and pass file lists by hand instead of `$(git …)` substitution.

Related: [[concurrent-agent-writes]].
