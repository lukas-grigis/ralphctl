<signals>

Use these signals to communicate task outcome to the harness. The harness parses your output for these tags; nothing
else in your message is treated as a control signal.

- `<task-verified>output</task-verified>` — Records the verification commands you ran and their output. Required
  before completion so the harness has on-disk evidence of what passed.
- `<task-complete>` — Marks the task as done. Emit ONLY after `<task-verified>` and only when every declared step
  has been completed and every verification command passes.
- `<task-blocked>reason</task-blocked>` — Marks the task as blocked. Use when you cannot proceed: missing
  dependency, ambiguous step, pre-existing failure, scope mismatch with the ticket. Be concrete in the reason —
  the harness surfaces this verbatim to the operator.

Optional progress signals you may emit during long-running work:

- `<progress>short summary</progress>` — A one-line status update; the harness streams these to the live UI.
- `<note>text</note>` — Incidental observations that future tasks should be aware of (patterns, gotchas).
- `<change>text</change>` — A concrete change you made during this task. Granular ("added X", "renamed Y to Z", "deleted Z"). The harness appends these inline to the task's section in `progress.md`.
- `<learning>text</learning>` — Non-obvious project knowledge worth carrying across tasks (a hidden constraint, an undocumented convention, a gotcha you hit and resolved). The harness pins these under `## Learnings` at the top of `progress.md` so future tasks see them. Use sparingly; only the kind of insight you'd want a fresh agent to read first.
- `` `<decision>` `` ... `` `</decision>` `` — Wrap a one-sentence architectural or design choice with rationale ("chose path A over B because <reason>"). Higher signal than `<learning>`. The harness pins these under `## Decisions` in `progress.md`. Use only for choices a future maintainer would want explained. Emit ONE decision per pair of tags; do not embed prompt headings or code fences inside the body.

Commit message — the harness owns the commit; you propose the wording (emit on every turn that produced edits):

- `<commit-message><subject>type(scope): imperative present tense, ≤72 chars</subject><body>WHY this change, what was considered, follow-ups — wrap lines at 72 chars; multiple paragraphs allowed</body></commit-message>` — Proposed message for the per-task `git commit` the harness runs after this turn. **Emit this on every task that touched a file.** The subject is required and should follow a Conventional Commits shape (`feat(scope): …`, `fix(scope): …`, `refactor(scope): …`, `chore(scope): …`, `docs(scope): …`). The body is required for anything beyond a trivial rename — explain WHY the change exists, what alternatives you considered, what follow-ups remain. The diff already shows the what; your body adds the reasoning a reviewer or future maintainer can't recover from the diff alone. Emit exactly one `<commit-message>` per turn; if you emit multiple, only the last one is used. Falling through to the default `task(<id>): <name>` produces uninformative history — omit only on pure-investigation turns that wrote nothing.

</signals>
