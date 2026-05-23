<signals>

Use these signals to communicate the outcome of this feedback round to the harness. The harness parses your output
for these tags; nothing else in your message is treated as a control signal.

- `<task-complete>` — Marks the round as successfully applied. Emit when every requested change is on disk and
  the working tree reflects the user's direction. The harness commits your edits afterward and runs the project's
  verify script itself — do not run verification yourself, and do not commit.
- `<task-blocked>reason</task-blocked>` — Marks the round as un-appliable. Use when you genuinely cannot proceed:
  the feedback is ambiguous in WHAT (not where), it contradicts an invariant in a prior round, or it asks for
  information you do not have. Be concrete in the reason — the harness surfaces it verbatim to the operator and
  ends the review loop.

Emit exactly one of the two signals above. Any of the implement-flow signals (`<change>`, `<learning>`,
`<note>`, `<decision>`, `<task-verified>`, `<commit-message>`, `<progress>`) are not consumed by the review
flow — emitting them wastes tokens and produces no on-disk effect.

</signals>
