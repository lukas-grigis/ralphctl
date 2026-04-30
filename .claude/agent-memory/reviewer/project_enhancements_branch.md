---
name: feature/enhancements branch context
description: Key facts about the enhancements branch (0.5.1 work) reviewed 2026-04-29
type: project
---

The `feature/enhancements` branch soft-reset from `ralphctl/20260428-191806-enhancements` adds:

- Default concurrency=3 with DAG failure isolation (skip-item/skip-repo in forEachTask)
- File-backed runs-store + InMemoryExecutionRegistry + daemon spawn/attach/stop/list-runs commands
- Skill loader (src/skills/default/) + skill-lifecycle pipeline steps in refine/plan/execute pipelines
- Canonical keyboard-map.ts single source of truth + help overlay + sticky notification bus
- bypassPermissions for headless Claude (was acceptEdits before)
- Parallel check scripts (sprint-start mode)

**Why:** 0.5.1 release prep

**Key bugs found in review:**

- `installDaemonSignalHandlers()` exported but never called — SIGTERM to daemon doesn't gracefully cancel registry
- Race: `detachAndExit` spawns daemon before `releaseSprintLock` completes (fire-and-forget release)
- 5 test files fail in full suite (all confirmed as test isolation, not code bugs)
- ARCHITECTURE.md step tables stale (missing link-skills/cleanup-skills in all three pipeline rows)

**How to apply:** Reference when reviewing or implementing daemon/skills features.
