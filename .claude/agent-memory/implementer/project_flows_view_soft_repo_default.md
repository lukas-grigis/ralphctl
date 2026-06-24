---
name: flows-view-soft-repo-default
description: flows-view launch handler runs a dedicated repo-selection step (soft default) BEFORE the customize picker; sessionRepositoryId is a re-pickable default, not a hard lock
metadata:
  type: project
---

The flows-view launch handler (`src/application/ui/tui/views/flows-view.tsx`, `onSelect` closure)
has a dedicated repository-selection step that runs RIGHT BEFORE `runCustomizePicker` — sequence is
"pick repo, then customize provider". Logic lives in
`src/application/ui/tui/views/flows-repository-picker.ts` (`runRepositorySelection` +
`flowSelectsRepository`), extracted so it's unit-testable with a scripted `InteractivePrompt`
(mirrors how `flows-customize-picker.ts` is structured/tested).

**Why:** `ui.sessionRepositoryId` used to be threaded as a HARD preselect into every launch
(`launchExtras.repositoryId`), which made `pickRepositoryLeaf` (`flows/_shared/project/pick-repository.ts`)
skip its prompt forever (`if (input.repositoryId !== undefined) return match`) — the user could never
change the repo after the first pick of a session. The fix turns the pin into a SOFT default: on every
launch of a repo-selecting flow against a multi-repo project, re-prompt with the pinned repo offered
FIRST (default highlight), capture the choice, re-pin via `ui.setSessionRepositoryId`, then thread
`repositoryId = chosenRepositoryId ?? ui.sessionRepositoryId` into `launchExtras`.

**How to apply:**

- Only THREE flows run `pickRepositoryLeaf` and thus select a repo: `detect-scripts`, `detect-skills`,
  `readiness`. Gate on an explicit `ReadonlySet<string>` allowlist — NOT `manifest.requiresProject`
  (that's broader: every project-scoped flow). Verify the set by grepping `pickRepositoryLeaf` under
  `src/application/flows/` before trusting it.
- These manifest ids are plain strings; `detect-scripts`/`detect-skills` are NOT in the `FlowId` type
  (`domain/value/flow-id.ts` is the AI-settings closed set: refine/plan/implement/readiness/ideate/createPr).
  So the gate keys on `string`, not `FlowId`.
- Skip the prompt (return `kind:'skip'`) when project undefined OR `repositories.length <= 1` — a
  single-repo project is auto-selected inside `pickRepositoryLeaf`; a 0-repo project surfaces its own
  InvalidStateError there. Don't duplicate either here.
- `askChoice` Esc → `Result.error` (AbortError family) → treat as `cancel`, `return` without launching
  (same as the existing `if (picker.kind === 'cancel') return`). See [[feedback_concurrent_agent_writes]]
  is unrelated; the AbortError-transparency rule is the relevant convention.
- The post-completion repo capture (`result.runner.subscribe` reading `ctx.repository.id`) stays in
  place — it just re-affirms the freshly-pinned id now, no double-prompt.
- Choice rendering must mirror `pick-repository.ts`: `{ label: `${r.name} (${slug})`, value: r,
description: String(r.path) }`.
