---
name: slugged-data-layout-resolver
description: Human-readable <id>--<slug> data/ layout — one shared tolerant id-prefix resolver in storage.ts; direct-build (write/entity-in-hand) vs resolver (read/id-only) split; reconcile-on-save
metadata:
  type: project
---

Wave 1 of the human-readable `data/` layout (`.claude/scratch/plan-data-layout-human-readable.md`, Tasks 1-5;
migration runner + learnings.md were a deferred Wave 2). On-disk entity names became `<id>--<slug>` (projects
files, sprint dirs, memory dirs). `--` is the separator; kebab slugs never contain `--`, so split on the FIRST
`--` to recover the id (`parseIdFromName`).

**The one centralized mechanism** lives in `src/integration/persistence/storage.ts`:

- `buildSluggedName(id, slug)` / `parseIdFromName(entry)` — pure, also strips trailing `.json`.
- `resolveEntityName(parentDir, id, suffix?)` — the ONLY tolerant scanner. One `listDir`, matches new
  `<id>--*` OR legacy bare `<id>`(+suffix); prefers the NEW form when both exist; ignores garbage/non-uuid.
- Per-entity wrappers: `resolveProjectPath` / `resolveSprintDir` / `resolveMemoryDir` (all async,
  `string | undefined`).
- Direct-build sync builders for the WRITE side (entity/slug in hand): `projectFile(root,id,slug)`,
  `sprintDir(root,id,slug)`, `sprintFile(root,id,slug)`. NOTE: `executionFile`/`tasksFile` builders were
  DELETED (knip dead-export) — the execution/task repos derive subpaths from the resolved dir instead.

**Direct-build vs resolver decision rule** (the load-bearing distinction):

- Caller holds the entity (and thus slug) → direct-build, no async scan. Launchers (snapshot.sprint),
  create-sprint leaves (ctx.sprint), repo `save`, distill/append-learnings (projectSlug threaded through opts).
- Caller holds only an id → async resolver. TUI views + progress-overlay (selection.sprintId), CLI commands,
  repo `findById`/`remove`/`list`, execution/task repos (entity carries only sprintId, no slug).

**Reconcile-on-save** (lazy convergence, independent of any bulk migration):

- Project repo: write canonical `<id>--<slug>.json` FIRST, THEN remove stale siblings (bare `<id>` or
  old-slug) — order matters so a crash never leaves zero readable files.
- Sprint repo: rename the stale dir onto the canonical name FIRST (atomic `fs.rename` via new `renamePath`
  in fs.ts — carries execution.json/tasks.json together), THEN write sprint.json. If canonical already
  exists, remove the stale dir instead. All best-effort (swallow failures — tolerant reader covers gaps).

**Memory ledger**: `learningsLedgerPath` was REPLACED by two functions in
`flows/_shared/memory/ledger-path.ts`: `resolveLearningsLedgerPath` (async, tolerant) and
`learningsLedgerPathDirect(memoryRoot, id, slug)` (pure). DECISION: thread `projectSlug` through
`CreateImplementFlowOpts` → `PerTaskSubchainOpts` → `AppendLearningsLeafOpts`, and through
`DistillStepOpts`/`CreateDistillLearningsOpts`, so all memory writers use direct-build (no async scan).

**UUIDv7 monotonic** (`domain/value/uuid7.ts`): RFC 9562 Method 1 — 12-bit `rand_a` is now a per-ms counter
(reset on new ms, increment same-ms, overflow bumps ms+1). Shape/regex unchanged. Module-level `lastMs`/`seq`.

**Gotcha — fail-fast ordering**: making a sprint-dir lookup async via the resolver can REORDER it before a
PATH gate that used to run effectively-first (the old inline `join` couldn't fail). create-pr.ts CLI +
create-pr-view.tsx both had to move the `checkCli` PATH gate BEFORE `resolveSprintDir` to keep the
"missing binary fails fast" contract (a test asserted the binary message, not "sprint dir not found").

**Test-fixture impact**: tests that hand-write a sprint dir then read it post-`save` must read the RESOLVED
dir (the save renamed it). Added `app.resolveSprintDir(id)` to `tests/helpers/real-fs-app.ts` and
`FIXED_PROJECT_SLUG` to `tests/fixtures/domain.ts`. Legacy-named fixtures use local
`legacy{Project,Tasks,Execution}File` helpers built from `sprintsDir`/`projectsDir` + bare id.
