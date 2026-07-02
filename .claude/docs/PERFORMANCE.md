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
/ Copilot / Codex process cannot strand the harness. The threshold is `settings.harness.idleWatchdogMs`
(60_000–3_600_000 ms, default 300_000 = 5 min), threaded into every adapter's `deps.idleMs` by
`provider-factory.ts`. Raise it for slow first-token models that pause mid-reasoning; lower it on a fast
network / short tasks to reclaim a hung child sooner.

**Resume of aborted Implement runs.** Tasks left in `in_progress` from a prior crash stay `in_progress` and
are queued FIRST on the next launch. The `start-attempt` leaf settles the leftover `running` attempt as
`aborted` (cause `process-crash`, kept in `attempts[]`) then opens a fresh attempt — no manual cleanup
required. The only path that resets a task to `todo` is `task unblock`.

**Iteration budget.** `settings.harness` carries:

- `maxTurns` (1–10) — generator-evaluator turns budgeted per attempt
- `maxAttempts` (1–10) — cap on attempts per task before transitioning to `blocked`
- `rateLimitRetries` (0–10) — adapter-side 429 retries
- `idleWatchdogMs` (60_000–3_600_000, default 300_000) — stdio-silence threshold before the idle watchdog
  SIGTERMs a wedged headless AI child
- `correctiveRetries` (1–5, default 2) — bounded in-round corrective nudges the harness issues when a
  generator or evaluator spawn exits without a valid `signals.json` (signals-missing / invalid-json /
  schema-mismatch) before the task self-blocks. Each nudge is a full resumed spawn; capped tighter
  than `maxTurns`/`maxAttempts` because it multiplies spawn cost INSIDE one round. Consumes no turn or
  attempt budget — nudges happen before the turn is recorded. See `contract/_engine/corrective-retry.ts`.
- `plateauThreshold` (2–5, default 3) — consecutive evaluator rounds flagging the same failed-dimension
  set before the loop exits with a plateau warning; score improvement, commit-progress, or
  critique-Jaccard shift can exempt a round from counting. The patient default (3) avoids spending an
  escalation rung on a stall the generator would have broken on its own. Must be ≤ `maxTurns` — the plateau window can
  never fill within a single attempt when the turn budget runs out first (escalation and nudge
  would be permanently unreachable). A violating PERSISTED pair self-heals at parse time
  (threshold clamps down to the turn budget, floors permitting) rather than failing the load —
  `maxTurns` 1–2 was valid before the invariant, and a parse failure would brick the TUI and the
  `settings set` repair command on upgrade.

Two additional plateau signals fire _inside_ each gen-eval turn via dedicated guard leaves, without
waiting for the `plateauThreshold` count:

- **`loop-diversity-check`** (`src/application/flows/implement/leaves/gen-eval-loop.ts`, backed by the
  rolling buffer `createLoopDiversityTracker` in `src/business/task/loop-diversity.ts`) — tracks a rolling
  window of failed-dimension fingerprints (sorted set of failing dimension names joined by `|`). When the last
  `DIVERSITY_WINDOW_SIZE` (3) fingerprints are identical the loop exits with `plateau`, letting the
  escalation ladder intervene earlier than the count-based predicate would. Tracker state resets at
  each new attempt so fingerprints do not leak across attempts.
- **`entropy-check`** — computes normalised Shannon entropy (`H = -Σ(p·log₂p)/log₂K`) over the
  generator's per-turn signal-kind distribution (decision / change / learning / note counts stamped
  on `ctx.lastTurnActionCounts` by the generator leaf). When `H < 0.25` (the agent concentrated
  its actions on one kind), the loop exits with `plateau`. **Honesty:** this is a
  _signal-kind-distribution proxy_ for action diversity — the harness never sees raw tool-use, so
  the spread of reported signal kinds stands in for "action variety." It is a secondary, softer signal
  to the fingerprint guard and does not fire on the first `DIVERSITY_WINDOW_SIZE` turns or when
  another exit is already pending. Both guards respect the budget-precedence invariant: when the
  current turn is the final budgeted turn, `finalize` synthesises the terminal state rather than an
  early plateau pre-empting it.

Mirrored on `IterationConfig` (`src/application/chain/run/iteration-config.ts`); the chain `loop` predicates
and the headless provider adapter read it.

**Escalation on plateau (and other non-passing exits).** On a plateau or turn-budget-exhausted exit
the gen-eval loop grants one more attempt rather than settling immediately. **Non-passing exits never
block the task** — the escalation policy spends remedies cheapest-first; true exhaustion of remedies
settles done-with-warning. Two `settings.harness` knobs tune it:

- `escalateOnPlateau` (default **`true`**) — flag gate; when off, all non-passing exits keep the
  legacy done-with-warning behaviour (no retry). Despite its name, this flag now gates ALL
  failure-driven escalation: plateau, budget-exhausted, and malformed exits.
- `escalationMap` (default `{}`) — user overrides merged over the built-in ladder. User keys win on
  conflict (allowing redirects) and user-only keys extend the ladder. Self-loops (`{ 'foo': 'foo' }`)
  parse but emit one warn-level log record per entry at settings load.

The escalation policy is a **graduated remedy ladder** (`src/business/task/escalation-policy.ts`)
spent cheapest-first across successive plateau or budget-exhausted exits:
(1) **model escalation** — climbs **one rung per exit** up `DEFAULT_ESCALATION_MAP`
(`src/business/task/escalation-map.ts`, seeding the common in-provider rungs Claude Haiku → Sonnet →
Opus in both dash-form Claude-Code/Codex ids and dot-form Copilot ids; Codex / Copilot `gpt-5-mini`,
`gpt-5.4-mini` and the economic full tier `gpt-5.4` → `gpt-5.5`, kept in lockstep with
`domain/value/settings-models/` by code review). Each exit re-reads the most-recent
`Task.escalatedToModel` as the generator model, so the policy returns `escalate` repeatedly and the
task climbs through every intermediate rung (bounded by `maxAttempts`).
(2) **effort escalation** — when the generator reaches the top of the model ladder (no stronger rung) the
policy tries a cheaper same-model remedy BEFORE the nudge: raise reasoning effort (`escalate-effort`) to a
**provider- and model-aware target** (`nextEffortRung` in `escalation-map.ts`) when the provider/model
exposes an effort dimension and the generator still has headroom. Claude is model-aware — Claude Code's own
CLI default is `xhigh` on xhigh-capable models (Opus 4.7/4.8, Sonnet 5, Fable 5), so the rung climbs Claude's
own tiers (`…→ xhigh → max`) rather than stamping a fixed `high` that would be a no-op or a downgrade of the
implicit default; an explicit `low|medium|high` climbs to `xhigh`, and `unset` (the CLI default) or `xhigh`
climbs to `max`, capping there. A non-xhigh-capable Claude model (Sonnet 4.6, CLI default `high`) climbs
straight to `max`. Copilot/Codex keep the fixed target `EFFORT_ESCALATION_TARGET` (`high`). It stamps
`Task.escalatedToEffort` (no model change), the generator leaf prefers that over the configured `effort` at
spawn, and the next plateau sees the raised effort. Fires once for the shipped default (unset `→ max` in a
single step) and is strictly bounded generally — the stamped effort climbs monotonically to the terminal
`max`, from which the rung is spent and falls through to the nudge. Skipped gracefully — straight to the
nudge — when the provider/model has no effort knob (e.g. Claude Haiku) or the generator is already at its
ceiling.
(3) **change-of-approach nudge** — a single same-model **"change your approach" directive**
(`{{PLATEAU_DIRECTIVE_SECTION}}` in the implement prompt) stamped `escalatedFromModel === escalatedToModel`.
The directive is gated on that same-model marker, NOT on a model bump: a bump hands the stronger model the
targeted `priorCritique` instead, decoupling the "abandon your approach" directive from escalation so it is
reserved for the top-of-ladder case where there is no fresh capability to lean on. A further exit after the
nudge tops out — keeping the work.

**Routing by exit kind.** `plateau` and `budget-exhausted` exits (including the synthesized budget-
exhausted when no leaf set `lastExit`) both go through `decideEscalation`. A `malformed` exit —
evaluator failure, not generator's — gets a plain same-model fresh-attempt retry (no ladder rung burned)
while the attempt budget remains, falling back to done-with-warning at the cap.

**Attempt budget and legacy tasks.** Newly-planned tasks carry `task.maxAttempts` stamped at plan time
(`settings.harness.maxAttempts` at the moment of planning). Legacy tasks planned before that stamp was
introduced have `task.maxAttempts === undefined`; `decideEscalation` and the per-task loop cap both fall
back to `settings.harness.maxAttempts` so the attempt budget binds for them too.

**Default posture: effort rung, then nudge.** The shipped default generator model (`claude-opus-4-8`) has
no key in `DEFAULT_ESCALATION_MAP`, so the harness never model-escalates it. But the effort rung IS live for
the default posture: opus is xhigh-capable and its effort is unset (Claude Code's implicit default is
`xhigh`), so on a plateau at the top of the ladder the rung raises reasoning effort to `max` on the same
model in a single step (a live remedy, not just a directive) — a fixed `high` would be a no-op or a downgrade
of that implicit `xhigh`. A further plateau (opus already at `max`, rung spent) fires the same-model nudge,
then settles done-with-warning. See `AI-SETTINGS.md § Default escalation posture` for how to also activate a
live MODEL ladder (economic presets or a custom escalationMap rung).

Escalation is generator-only by design — the evaluator's model is held constant across the task so the
scoring rubric does not shift mid-task, which would make plateau detection meaningless. `Task`'s
`escalatedFromModel` / `escalatedToModel` (model bump / nudge marker) and `escalatedToEffort` (effort rung)
fields are re-stampable and hold the MOST-RECENT transition; the cost ceiling is enforced by the ladder top
plus `maxAttempts` (each escalate / effort-bump / nudge fails the running attempt, consuming budget), not by
a once-per-task cap. A non-passing exit with no attempt budget left, or after the top-of-ladder nudge,
preserves the work (done-with-warning) — never blocks.
Cross-provider escalation (e.g. `claude-opus-4-8` → `gpt-5.5`) is intentionally deferred — switching
providers mid-task carries auth / context / tool-availability hazards.

**Verify-gate cost and scoping.** In a measured 23-min single-task sprint, the repo-wide verify script ran four
times per task (harness pre + post + generator in-turn + evaluator in-turn). The following knobs reduce that cost:

- **Verification division of labor** (prompt-level, not a settings key): the generator runs only per-criterion
  commands; the evaluator runs every auto criterion but not the repo-wide script; the harness post-verify is the
  sole authoritative full-gate run. The `PRE_VERIFY_RESULTS` placeholder (implement + continuation prompts) lets
  the generator review the pre-task baseline rather than re-running it.
- **`Repository.verifyGates`** (`VerifyGate[]` — `{ pathPrefix, command, timeoutMs? }`) enables per-module gate
  scoping: pre-task verify runs ALL gates (complete attribution baseline); post-task verify runs only the gates
  whose `pathPrefix` matches the attempt's diff footprint (`git diff --name-only HEAD` + untracked), fail-fast.
  A footprint probe failure or an empty footprint falls back to running all gates — a gate is never silently
  skipped. A monorepo task touching one module no longer pays every other module's suite on every verify pass.
  The legacy single `verifyScript` normalises to one catch-all `pathPrefix: ''` gate — non-gated repos are
  byte-for-byte the prior behaviour.
- **`settings.harness.skipPreVerifyOnFreshSetup`** (default `false`) — skip the FIRST pre-task verify of a run
  when this launch's own setup script already proved the tree green. The skip synthesizes the same green
  `VerifyRun` shape the carry-baseline path produces, so the `PRE_VERIFY_RESULTS` block and attribution fold
  through one code path. Safe only when the setup script actually verifies the tree, not merely installs
  dependencies. See `AI-SETTINGS.md § settings.harness keys`.

Wall-clock per gen-eval round: setup (once at sprint start) + pre-verify + generator turn(s) + evaluator turn(s) +
post-verify + commit. Post-verify dominates for monorepos; `verifyGates` diff-scoping is the highest-leverage knob there.

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

**Oversized prior-context section compression.** `PRIOR_PROGRESS`, `PRIOR_LEARNINGS`, and `PRIOR_EPISODES`
are tail-compressed to at most `SECTION_CHAR_CAP` (4,000) characters each before prompt substitution
(`src/integration/ai/prompts/_engine/compress-section.ts`). When a section overflows, the oldest bytes are
dropped and a one-line notice is prepended at the truncation boundary so the model sees where content was
omitted. Keeping the _most-recent_ tail follows the "Lost in the Middle" finding (Liu et al.,
arXiv 2307.03172): LLMs attend poorly to content placed in the middle of long contexts, so
pushing task-critical sections (goal, success-criteria, output contract) toward the middle is the
failure mode being avoided. The harness already applies the same principle to stderr via `BoundedTail`.

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
project-scoped append-only NDJSON ledger at `<dataRoot>/memory/<projectId>--<slug>/learnings.ndjson` by
`appendLearningsLeaf` (inserted immediately before `progress-journal` in the attempt-loop body;
best-effort — a write failure is logged, never fatal). Each `LearningRecord` (the single source of
truth at `src/application/flows/_shared/memory/learning-record.ts`) carries `{ v, id, text, context?, appliesTo?, repo,
repoName, taskKind, sprintId, taskId, timestamp, promotedAt }`; `id` is a stable
`sha1(repo|taskKind|normalize(text))[:16]` dedup key and `promotedAt` is `null` on write.
`text` is the Insight (required); `context` (when/why it arose) and `appliesTo` (where it applies) are optional and
render as indented `Context:` / `Applies to:` sub-bullets in `progress.md` and the distilled `## Learnings (ralphctl)`
section. A **`learnings.md` human-readable mirror** is written alongside the NDJSON ledger on every append and
promote (`appendLearningsAndMirror` in `ledger-writer.ts`); `stamp-promoted` also regenerates it after
compaction. The mirror is best-effort — a write failure is logged, the NDJSON append already landed, and the
mirror self-heals on the next write. A one-syscall byte-ceiling guard (`LEDGER_HARD_CEILING_BYTES = 50 MB`,
`ledgerExceedsCeiling` in `read-ledger.ts`) prevents loading a pathologically large ledger — an over-ceiling
file is rotated to `.bak` and the mirror render is skipped rather than overwriting a real `learnings.md` with
an empty view. At sprint close — BOTH the explicit `close-sprint` flow and the `review` flow's auto-done path —
an opt-in, human-gated **distill** step (defaults to No) promotes curated, not-yet-promoted learnings into each
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

## Diagnosing an OOM (heap snapshot)

The heap watchdog (`startHeapWatchdog`) warns and sheds in-memory buffers as the V8 old-space
fills, but if the process still aborts (`exit 134`, "JavaScript heap out of memory") the in-memory
buffers vanish with it. To capture _what_ the heap held at the moment of death, relaunch with V8's
near-heap-limit snapshot:

```bash
pnpm dev:heap-snapshot   # = mkdir -p .diagnostics && NODE_OPTIONS='--max-old-space-size=8192
                         #     --heapsnapshot-near-heap-limit=2 --diagnostic-dir=.diagnostics' tsx src/index.ts
```

- **Where the dump lands.** `--diagnostic-dir=.diagnostics` writes the snapshot to `<repo>/.diagnostics/`
  (gitignored). Without `--diagnostic-dir`, V8 writes to the process's **current working directory** — for
  `pnpm dev` that is the repo root, so the script pins it to `.diagnostics/` to keep the tree clean. The
  directory is NOT auto-created, hence the `mkdir -p`.
- **Filename.** `Heap.<YYYYMMDD>.<HHMMSS>.<pid>.<tid>.<seq>.heapsnapshot`.
- **Size.** The file is roughly the size of the live heap — near an 8 GB limit expect a **multi-GB** file
  per snapshot (`=2` writes up to two). Delete `.diagnostics/` when done.
- **Reading it.** Chrome/Edge DevTools → **Memory** → **Load** → pick the `.heapsnapshot` → sort by
  _Retained Size_ / open the _Dominators_ view. A retained-memory leak shows one structure dominating; a
  commit/throughput storm (the failure mode the coalescer fixes) shows transient React Fiber + Ink `Output`
  cell arrays dominating, with every bounded ring buffer small — i.e. nothing is actually _retained_.

For the installed binary instead of `pnpm dev`, set the same flags yourself:
`NODE_OPTIONS='--heapsnapshot-near-heap-limit=2 --diagnostic-dir=/tmp/ralphctl-diag' ralphctl`.

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
