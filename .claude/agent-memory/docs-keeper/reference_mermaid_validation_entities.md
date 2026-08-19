---
name: reference-mermaid-validation-entities
description: HTML entities (&lt;/&gt;) inside mermaid blocks are a REAL parse error — mermaid's own parser rejects them, GitHub included; always use raw <angle brackets> in diagram bodies
metadata:
  type: reference
---

HTML entities (`&lt;` / `&gt;`) inside mermaid participant aliases or message text are a **hard parse
error in mermaid itself** (verified against mermaid 11.15 `mermaid.parse()` on 2026-08-19: the `;` in
the entity terminates the statement). GitHub renders mermaid with the same parser, so an entity-bearing
diagram shows as a parse error there too — an earlier conclusion that "GitHub handles the entities
fine" and mmdc's rejection was a false alarm was **wrong** and was corrected in review.

**How to apply:** use RAW angle brackets inside mermaid blocks — `participant Disk as <outputDir>/`,
`read implement/<taskId>/rounds/<N>/...` — mermaid accepts them (02-sprint-lifecycle.md's raw `<id>`
always parsed). `04-ai-session-data-flow.md` was fixed this way; **`01-flow-lifecycle.md` still uses
entities and still fails to parse — open follow-up.** Entities remain fine in surrounding prose.

Validating an edit: extract the fenced block and run mermaid's real parser, e.g.
`npm i mermaid` in a scratch dir, then `mermaid.parse(text)` in node — a parse-OK there is the signal
GitHub will render it. `mmdc` needs a browser but agrees with `parse()` on validity.

Other conventions these files establish (match them, don't invent): `<br/>` for participant line
breaks, `·` middot as an inline separator, `-->>` dashed for replies, `X->>X` for self-messages, and no
backticks inside mermaid text — the surrounding prose uses backticks, the diagram body never does.
Style fence is `.claude/docs/diagrams/README.md` § Conventions: plain syntax, no themes/classDef.

Related: [[reference-step-trace-locations]], [[project-high-drift-areas]].
