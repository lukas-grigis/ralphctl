---
name: migration-consent-gate-wiring
description: Wave 2b TTY migration consent gate — MigrationGate Ink screen + launch.ts pre-app routing, renderLearnings adapter location, gate state machine
metadata:
  type: project
---

Wave 2b wired the data-migration consent SPLASH that drives the Wave 2a engine
(`integration/persistence/data-migration/createDataMigrationEngine()`: `needsMigration`/`dryRun`/`apply`).

**Why:** the user was badly burned by a past migration — the consent gate is the WHOLE safety story;
nothing mutates data without an explicit click. Wave-1 tolerant readers are the net under every
non-consent outcome.

**How to apply:**

- Gate component: `src/application/ui/tui/migration/migration-gate.tsx`. PRE-APP route — no router/deps/
  prompt context (those mount with the App), so everything (engine, dataRoot, stateRoot, appVersion,
  now, writeFile, onResolve, onQuit) arrives as PROPS. State machine: scanning→consent→applying, plus
  lock-held / dry-run-blocked / failed. Outcomes: `migrated` | `skipped` | `failed-continue`.
- The `renderLearnings` adapter for `ApplyCtx` MUST live in the application/UI layer (integration can't
  import the app-layer `renderLearningsMd`): `src/application/ui/tui/migration/learnings-backfill-adapter.ts`
  parses raw ndjson via `parseLearningLine` then calls `renderLearningsMd`; returns undefined on empty
  so the backfill write is skipped.
- Route wrapper: `migration-route.tsx` (`MigrationRoute`) renders gate first, swaps to `<App>` on
  resolve via local useState; `onResolved` callback flips a LAUNCH-CLOSURE flag (not React state, lost
  on pause/resume remount) so an AI-session pause never re-shows the gate.
- launch.ts wiring: bootstrap() computes `migration.pending = needsMigration(dataRoot)` AFTER
  ensureStorageRoots; `renderElement` thunk calls `shouldShowMigrationGate(pending, gateResolved)`
  (exported pure helper — the testable seam) to choose `MigrationRoute` vs `App`. appVersion =
  `CLI_METADATA.currentVersion`, now = `() => String(deps.clock())`.
- cli/bootstrap.ts: NO splash, NO auto-migrate (one-shots run headless on tolerant readers); a comment
  states the TUI owns consent.
- Failure screen names downgrade `npm install -g ralphctl@<PRIOR_VERSION_FALLBACK '0.6.0'>` — marker's
  `lastWrittenByAppVersion` is unstamped on failure (only written on full success), so the fallback is
  the honest version; don't try to read the marker post-failure (engine port doesn't expose it).
- Test gotcha: .tsx test files must NOT import React (automatic JSX runtime) — tsc flags it unused.
  Vitest positional args after `--` did NOT filter; run files by path: `vitest run <path1> <path2>`.
