# Performance & Limits

> On-demand reference (split out of `CLAUDE.md`). Read when working on the scheduler / parallel waves,
> rate-limit retry, the iteration budget, plateau escalation, the trace buffer, the progress journal,
> the learning ledger, or environment / release mechanics.

**Implement runs tasks in dependency order; parallel execution is opt-in.** `Task.order` (set as `i + 1` at parse
time by `parseTaskList` in `src/integration/ai/prompts/_engine/parse-task-list.ts`) is the
intra-level tiebreak; `Task.dependsOn` carries the dependency edges (the planner emits them as
`blockedBy` in the wire format and `parseTaskList` resolves them onto `dependsOn`). Graph validity —
unknown dependency / self-edge / cycle — is owned by `validateTaskGraph` (`src/domain/entity/task-graph.ts`)
and enforced at **both** boundaries: `parseTaskList` calls `scheduleIntoWaves` (Kahn's algorithm by
dependency level, `Task.order` ASC within each level) and rejects the task list on a bad graph, and
`resolveImplementQueue` (`src/application/ui/shared/launch/implement.ts`) re-runs `scheduleIntoWaves`
at launch so a cyclic / dangling sprint fails fast with the rendered `TaskGraphIssue` rather than
silently surfacing as an empty "No tasks to implement" queue. When `settings.concurrency.maxParallelTasks === 1`
(the default), the scheduled levels flatten into one serial queue — byte-for-byte the prior behaviour.
When `maxParallelTasks > 1` (range 1–5, Zod-clamped), the above-the-chain orchestrator `runWaves`
(`src/application/chain/run/wave-scheduler.ts`) runs each dependency wave's tasks concurrently up to
that cap; waves stay strictly sequential (wave k+1 starts only after every branch of wave k settled and
merged). Each task runs in its own isolated git worktree at `<sprintDir>/worktrees/wt-<taskId>`,
forked from the sprint-branch tip; the repo's `setupScript` runs inside each fresh worktree (a
worktree has none of the main repo's build artefacts). A setup failure blocks only that task — it
never hard-aborts the wave. Each worktree's commit is folded onto the single shared sprint branch
(`git merge --ff-only`, else `cherry-pick`) through one serialised in-process fold queue, so a
multi-task parallel sprint lands as one PR. When two same-wave tasks touch the same file the first
folds cleanly; the second's cherry-pick conflicts → that task transitions to `blocked` (`cherry-pick
--abort`, siblings stay `done`); a relaunch re-forks from the advanced tip and usually succeeds.
Waves partition on dependency edges, not file overlap — conflict is resolved at fold time, not
scheduling time. The sprint lock (`repoLockFile(locksRoot, sprintDir)`) spans prologue + waves +
epilogue using the same lock key as the serial path, so a serial and a parallel run of the same
sprint mutually exclude. Commits durably folded before an abort are preserved by the epilogue and
never re-executed on relaunch. Concurrent appends to `progress.md` and the learnings ledger are
serialised through one in-process mutex (no torn lines under fan-out). Launch then applies a
status-only stable override: `in_progress` tasks first (so a resumed sprint picks up the previously
aborted task before any fresh work), then `todo`; V8's stable sort preserves dependency order within
each status group. A `dependency-gate` leaf at the head of every per-task subchain enforces the
prerequisite contract at run time: if any `dependsOn` task is not `done` (blocked or still unsettled),
the dependent transitions to `blocked` with `blockKind: 'upstream'` and the subchain body is skipped — no AI
spawn wasted. `BlockedTask.blockKind: 'upstream' | 'own'` is the structural discriminant; `isUpstreamBlocked`
reads it — never the reason-string prefix. Legacy `tasks.json` entries without `blockKind` are migrated at
read time. The gate is status-only and works in both the serial and parallel paths. Block is transitive by
construction (A → B → C cascades automatically). Unblocking the root prerequisite cascade-unblocks the
entire upstream-blocked subtree in one action (`unblockTaskUseCase` calls `upstreamBlockedDependents` and
rewrites the list atomically); own-failure blocks are never auto-cleared.

**Rate-limit retry is adapter-side.** The headless provider wrapper at
`src/integration/ai/providers/_engine/rate-limit-backoff.ts` sleeps with exponential delay between 429
retries. Per-spawn cap is `settings.harness.rateLimitRetries` (range 0–10). Coordinator pause / resume
events bridge to the EventBus; the TUI's `StatusBanner` (tiered `info` / `warn` / `error`) replaces the
old single-purpose `RateLimitBanner`.

**Idle-stdout watchdog** kills wedged headless AI children past a configurable idle threshold. A stuck Claude
/ Copilot / Codex process cannot strand the harness.

**Resume of aborted Implement runs.** Tasks left in `in_progress` from a prior crash reset to `todo` on next
launch and re-enter the queue. No double-execution.

**Iteration budget.** `settings.harness` carries:

- `maxTurns` (1–10) — generator-evaluator turns budgeted per attempt
- `maxAttempts` (1–10) — cap on attempts per task before transitioning to `blocked`
- `rateLimitRetries` (0–10) — adapter-side 429 retries
- `plateauThreshold` (2–5, default 2) — consecutive evaluator rounds flagging the same failed-dimension
  set before the loop exits with a plateau warning; score improvement, commit-progress, or
  critique-Jaccard shift can exempt a round from counting

Mirrored on `IterationConfig` (`src/application/chain/run/iteration-config.ts`); the chain `loop` predicates
and the headless provider adapter read it.

**Escalation on plateau.** On a plateau the gen-eval loop grants one more attempt rather than settling
immediately. **A plateau never blocks the task** — it either retries once or preserves the work
(done-with-warning). Two `settings.harness` knobs tune it:

- `escalateOnPlateau` (default **`true`**) — flag gate; when off, a plateau keeps the legacy
  done-with-warning-on-first-plateau behaviour (no retry).
- `escalationMap` (default `{}`) — user overrides merged over the built-in ladder. User keys win on
  conflict (allowing redirects) and user-only keys extend the ladder. Self-loops (`{ 'foo': 'foo' }`)
  parse but emit one warn-level log record per entry at settings load.

The one plateau-break attempt does two things: (1) **model escalation** — climbs one rung up
`DEFAULT_ESCALATION_MAP` (`src/business/task/escalation-map.ts`, seeding the common in-provider rungs
Claude Haiku → Sonnet → Opus; Codex / Copilot `gpt-5-mini` and `gpt-5.4-mini` → `gpt-5.5`, kept in
lockstep with `domain/value/settings-models/` by code review) when a stronger rung exists; and (2) a
**"change your approach" directive** (`{{PLATEAU_DIRECTIVE_SECTION}}` in the implement prompt) injected
into the generator turn, telling it to abandon the non-converging approach and try a fundamentally
different one. The directive is gated on the write-once `Task.escalatedFromModel` flag, so it renders
on every generator turn from the escalated attempt onward (not a single turn) — intentional and
harmless: re-telling the generator to change approach costs nothing and the once-per-task cap still
bounds the model bump. For a top-of-ladder generator (e.g. the default Opus) there is no higher
model, so the attempt keeps the model and relies on the directive (a same-model "nudge" — stamped
`escalatedFromModel === escalatedToModel` so the once-per-task cap still fires).

Escalation is generator-only by design — the evaluator's model is held constant across the task so the
scoring rubric does not shift mid-task, which would make plateau detection meaningless. The policy fires
at most once per task (`Task.escalatedFromModel` / `escalatedToModel` are write-once): after the single
plateau-break attempt, a second plateau — or a plateau with no attempt budget left — preserves the work
(done-with-warning), never blocks. Cost ceiling is bounded: at worst one extra attempt per task.
Cross-provider escalation (e.g. `claude-opus-4-8` → `gpt-5.5`) and a multi-rung ladder are intentionally
deferred — switching providers mid-task carries auth / context / tool-availability hazards, and the
same-model nudge already gives a top-of-ladder generator a way to act differently.

**Trace ring buffer.** The runner caps `runner.trace` at `MAX_TRACE_ENTRIES = 5_000`
(`src/application/chain/run/runner.ts`). The `TaskRoundStarted` event (carrying `roundN`,
`attemptN`, `totalCap`) drives the `round N/M` display — replacing the old React-ref high-water mark.

**Optional `<sprintDir>/events.ndjson`** — opt-in via `RALPHCTL_DEBUG_TRACE=1`. When enabled, every
implement-style run appends its full trace, bracketed by `=== chain-run <id> <flowId> started <iso> ===` /
`… completed/failed/aborted …` delimiters. `tail -f`-friendly. The sink is bounded (in-memory drain queue
with drop-newer back-pressure) so it cannot OOM under high event rate. Default factory is no-op so unset
envs incur zero memory cost.

**`progress.md` is an append-only journal** (audit-[07]), not streamed or regenerated. `init-progress-journal`
writes a one-time sprint header at creation; after each `settle-attempt-<taskId>` the `progress-journal` leaf
appends one task-attempt section via `renderJournalEntry` (a pure formatter). It reads no log files — the
canonical state lives in `tasks.json` / `execution.json`. Appends are best-effort: a write failure is logged
and the next attempt's append heals the file.

**Per-round artifacts.** Generator and evaluator prompts land at `rounds/<N>/{generator,evaluator}/prompt.md`
before each spawn; `settle-attempt-leaf` writes `rounds/<N>/outcome.md` after settlement.

**AI signal routing.** `<change>` / `<decision>` / `<learning>` / `<note>` signals accumulate per-attempt on the
implement ctx (`ctx.currentAttempt{Changes,Decisions,Learnings,Notes}`) as the generator / evaluator leaves parse them;
`progress-journal` dedupes each list and `renderJournalEntry` writes the per-attempt `### Changes` / `### Decisions` /
`### Learnings` / `### Notes` subsections (empty subsections are dropped). The same signals also fan out as
`HarnessSignalEvent` on the EventBus for live TUI panels; when `RALPHCTL_DEBUG_TRACE=1` they additionally land in
`<sprintDir>/events.ndjson` for debug — never read back by the harness. A `<learning>` carries a required Insight (
`text`) plus optional `context` (when/why) and `appliesTo` (where); the `### Learnings` subsection renders each as a \*
\*bold Insight\*\* bullet with indented `Context:` / `Applies to:` sub-bullets (omitted when absent) — unlike the flat
single-line bullets for changes, decisions, and notes.

**Procedural memory (learning ledger).** Per-attempt `<learning>` signals are also appended to a
project-scoped append-only NDJSON ledger at `<dataRoot>/memory/<projectId>/learnings.ndjson` by
`appendLearningsLeaf` (inserted immediately before `progress-journal` in the attempt-loop body;
best-effort — a write failure is logged, never fatal). Each `LearningRecord` (the single source of
truth at `src/application/flows/_shared/memory/learning-record.ts`) carries `{ v, id, text, context?, appliesTo?, repo,
repoName, taskKind, sprintId, taskId, timestamp, promotedAt }`; `id` is a stable
`sha1(repo|taskKind|normalize(text))[:16]` dedup key and `promotedAt` is `null` on write.
`text` is the Insight (required); `context` (when/why it arose) and `appliesTo` (where it applies) are optional and
render as indented `Context:` / `Applies to:` sub-bullets in `progress.md` and the distilled `## Learnings (ralphctl)`
section. At sprint
close — BOTH the explicit `close-sprint` flow and the `review` flow's auto-done path — an opt-in,
human-gated **distill** step (defaults to No) promotes curated, not-yet-promoted learnings into each
provider's native context file via the same per-distinct-provider fan-out as `readiness` (one file
per provider, no symlinks), then stamps the accepted ids `promotedAt` so they are never re-proposed.
The self-contained distill sub-chain runs while the sprint is still `review`, so a mid-distill abort
leaves it un-closed and re-runnable. Prompt: `src/integration/ai/prompts/distill-learnings/`;
implementation: `src/application/flows/_shared/memory/`.

**Skill suggestions.** The `readiness` flow acts on `SkillSuggestionsSignal`: after `write` and
before `install-readiness-skills`, `offerSkillSuggestionsLeaf` surfaces each suggested skill —
a bundled skill gets an install confirm, an unknown skill gets a scaffold confirm. The human gate is
mandatory; nothing auto-installs. Accepted suggestions persist on `Repository.suggestedSkills`.
Resolution uses the `SkillSource.getByName` lookup on the bundled source.

`settings.ui.notifications.enabled` (default `true`) gates terminal bell + macOS `osascript`.

## Environment variables

| Variable                     | Default        | Range / values   | Purpose                                                          |
| ---------------------------- | -------------- | ---------------- | ---------------------------------------------------------------- |
| `RALPHCTL_HOME`              | `~/.ralphctl/` | absolute path    | Override application root (data + config + state)                |
| `RALPHCTL_SKIP_LEGACY_CHECK` | unset          | any truthy value | Bypass the v0.6.x legacy-layout detector at boot                 |
| `RALPHCTL_DEBUG_TRACE`       | unset          | any truthy value | Enable `<sprintDir>/events.ndjson` debug sink (no-op when unset) |
| `RALPHCTL_NO_TUI`            | unset          | any truthy value | Suppress implicit interactive prompts inside the implement flow  |
| `NO_COLOR`                   | unset          | any truthy value | Suppress ANSI colors                                             |
| `CI`                         | auto-detected  | any truthy value | Suppress implicit interactive prompts inside the implement flow  |

## Release procedure

GitHub Actions auto-publishes on tags `v[0-9]+.[0-9]+.[0-9]+`. Tag must match
`package.json#version`; `CHANGELOG.md` needs a `## [X.Y.Z]` section (the literal-prefix extractor surfaces
it). NPM publish uses `--provenance`. Pre-releases are tags containing `-`.

## References

Principles distilled in `.claude/docs/HARNESS-PRINCIPLES.md`; consult before structural
changes to the chain framework, flow registry, or provider engine. Sources: [Anthropic — Effective
Harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents), [Anthropic
— Harness Design](https://www.anthropic.com/engineering/harness-design-long-running-apps), [Martin Fowler
— Harness Engineering](https://martinfowler.com/articles/harness-engineering.html).
