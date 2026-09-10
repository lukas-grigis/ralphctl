The unit is one coherent feature or vertical slice — a change that can be picked up cold,
implemented in a single session, and verified end-to-end against its criteria.

**Do not split when:**

- A utility and its first caller would be separated — create-and-use is always one task, unless
  the utility already exists in the codebase or a prior task in this plan produces it.
- A feature and its tests would be separated.
- The same pattern applies across N call sites — it is one refactor, not N tasks.

**Do split when:**

- Two chunks are independent (different `projectPath`, or independent files with no shared
  contract).
- A clean, verifiable boundary exists partway through (e.g. schema + migration land first, then
  consumer wiring — the schema is independently testable).
- The change spans multiple repositories — one task per repo, connected via `blockedBy`.

**Fold trivial cases into the task that needs them** rather than giving them their own entry: a
`blockedBy` chain added for no real code reason, one task per file modification, or a
micro-refactor (add a directive, remove an import) — merge each into the task it serves instead of
splitting it out.

**Soft ceiling, not a target:** if a task will touch more than ~10 files or ~500 lines of
meaningful change AND a natural split point exists, split it. No natural split point? Keep it
whole.
