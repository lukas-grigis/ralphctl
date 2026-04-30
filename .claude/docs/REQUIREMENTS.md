# RalphCTL — Acceptance Criteria

Testable acceptance criteria for all features. For constraints and module layout, see the root CLAUDE.md. For data
models, the chain framework, and the storage layout, see [ARCHITECTURE.md](./ARCHITECTURE.md) and
[KERNEL-DESIGN.md](./KERNEL-DESIGN.md).

## Clean Architecture & Layering

- [ ] Five modules under `src/`: `kernel < domain < business < integration < application`
- [ ] Both `kernel/` and `domain/` are pure, leaf-importable, zero IO
- [ ] `business/` may import from `domain/` and `kernel/`; `integration/` may import from `business/`, `domain/`,
      `kernel/`; `application/` may import from anywhere
- [ ] ESLint `no-restricted-imports` enforces every direction (see `eslint.config.js`)
- [ ] Repository interfaces (`ProjectRepository`, `SprintRepository`, `TaskRepository`) live in
      `src/domain/repositories/` — one per aggregate root
- [ ] Service ports (`AiSessionPort`, `ExternalPort`, `LoggerPort`, `PromptPort`, `PromptBuilderPort`,
      `SignalBusPort`, `SignalHandlerPort`, `SignalParserPort`) live in `src/business/ports/`
- [ ] Concrete adapters live under `src/integration/`
- [ ] No barrel `index.ts` files anywhere under `src/`

## Chain framework (kernel)

- [ ] Six concepts only: `Element`, `Leaf`, `Sequential`, `Parallel`, `Retry`, `OnError` — one file each under
      `src/kernel/chain/`
- [ ] `Element<TCtx>` has a single `execute(ctx, signal?) → Result<{ ctx, trace }, { error, trace }>` method
- [ ] `Sequential` runs elements in order, threading `ctx`; first error aborts remaining elements; trace is appended
- [ ] `Parallel` fans elements out concurrently with a `concurrency` cap and `failureMode: 'fail-fast' | 'collect-all'`
- [ ] `Retry(element, { maxAttempts, backoff, retryOn })` re-runs on `Result.isErr` matching `retryOn`
- [ ] `OnError(element, { catchIf, fallback })` runs `fallback` when an error matches `catchIf`
- [ ] Conditionals are NOT a primitive — branching lives in use cases or sub-chains selected by the caller
- [ ] Every chain run returns a `ChainTrace` of `{ stepName, status, durationMs, error? }` entries
- [ ] Every chain definition has an integration test asserting `trace.map(s => s.stepName)` for happy + failure paths

## Use cases

- [ ] Every business operation is a class with constructor-injected port dependencies and a single `execute()` method
- [ ] All use case `execute()` methods return `Result<T, DomainError>` from `typescript-result`
- [ ] Domain errors carry a machine-readable `code` and optional `cause` (see `DomainError` subclasses in
      `src/domain/errors/`)
- [ ] Use cases are unaware of the chain framework — `Leaf` is the seam (`Leaf` adapts `UseCase.execute(input)` into
      `Element.execute(ctx)`)
- [ ] Every use case has a unit test against fake ports
- [ ] Result re-export is `src/domain/result.ts` — every consumer imports `Result` and `AsyncResult` from there
      rather than reaching into `typescript-result` directly

## Multi-chain runtime (SessionManager)

- [ ] `SessionManagerPort` (`src/application/runtime/session-manager-port.ts`) defines the registry interface
- [ ] `SessionManager` (`session-manager.ts`) is the in-memory implementation
- [ ] `start({ element, initialCtx, label }) → SessionId` registers a `ChainRunner`, kicks off `runner.start()`, and
      emits `{ type: 'added' }`
- [ ] `list()` returns descriptors in insertion order
- [ ] `foreground(id)` emits `{ type: 'active-changed', sessionId: id }`; no-op when already active
- [ ] `background()` drops the active marker and emits `{ type: 'active-changed', sessionId: null }`
- [ ] `kill(id)` aborts the runner and removes it from the registry
- [ ] `dispose()` aborts every in-flight runner and clears the registry
- [ ] Subscriber discipline: a thrown listener never stalls delivery to other subscribers
- [ ] CLI parity: `ralphctl sessions list / attach / detach / kill` (see
      `src/application/cli/commands/sessions-*.ts`)
- [ ] TUI parity: dedicated Sessions view (`application/tui/views/sessions-view.tsx`) lists every runner with status +
      age
- [ ] Tab cycles sessions, Shift+Tab cycles backwards, `Ctrl+1..9` direct-jump (handled in
      `tui/views/use-global-keys.ts`)
- [ ] Backgrounding does not pause the runner; it only detaches the UI
- [ ] Late subscribers receive a synthetic event matching the runner's terminal state if it has already settled
- [ ] CLI commands and TUI views invoke chain factories and launch via `SessionManager.start(...)` — never
      `chain.execute()` directly

## Workflow chains

Every workflow is a chain factory under `src/application/chains/<name>/<name>-flow.ts`. Each factory returns
`Element<TCtx>` ready to launch via `SessionManager.start(...)`. Step orders below are locked by integration tests.

### Refine

- [ ] `createRefineFlow(deps, opts)` returns an `Element<RefineCtx>`
- [ ] Step trace: `load-sprint → assert-draft → link-skills → refine-tickets (Sequential of per-ticket sub-chains,
each: refine-<id> → save-after-<id>) → unlink-skills`
- [ ] Per-ticket save persists the approved ticket BEFORE moving to the next ticket (resumable)

### Plan

- [ ] `createPlanFlow(deps, opts)` returns an `Element<PlanCtx>`
- [ ] Asserts all tickets `requirementStatus === 'approved'` before running the AI session
- [ ] Reorders tasks by dependencies after import
- [ ] Atomically replaces existing tasks via `TaskRepository.save` (interruption-safe)

### Ideate

- [ ] `createIdeateFlow(deps, opts)` returns an `Element<IdeateCtx>`
- [ ] Creates ticket and generates tasks in one session; auto-assigns `ticketId` to generated tasks

### Execute

- [ ] `createExecuteFlow(deps, opts)` returns an `Element<ExecuteCtx>`
- [ ] Outer step trace: `load-sprint → assert-active → load-tasks → assert-tasks-not-empty →
check-scripts-sprint-start → link-skills → execute-tasks (Parallel) → unlink-skills`
- [ ] `execute-tasks` is a `Parallel` whose children are `createPerTaskFlow(deps, { task, sprint })` instances
- [ ] Concurrency defaults to 4 and `failureMode: 'collect-all'` so one failing task doesn't abort the others

### Per-task (nested inside `executeFlow`'s Parallel)

- [ ] Step trace: `branch-preflight → mark-in-progress → execute-task → post-task-check → recover-dirty-tree →
evaluate-task → mark-done`
- [ ] `branch-preflight` wrapped in `OnError(catchIf: invalid-state, fallback: mark-blocked)` — wrong-branch repos
      don't crash the sprint
- [ ] `execute-task` wrapped in `Retry(maxAttempts: 2, retryOn: code === 'rate-limited')`
- [ ] `evaluate-task` runs the nested evaluate chain; wrapped in `OnError(catchIf: () => true, fallback: noop)` so
      evaluator failure never blocks the task
- [ ] `post-task-check` skips cleanly when no `checkScript` is configured for the task's repo

### Evaluate

- [ ] `createEvaluateFlow(deps, opts)` returns an `Element<EvaluateCtx>`
- [ ] Step trace: `load-sprint → load-task → check-already-evaluated → evaluate-task → persist-evaluation`
- [ ] Use case never blocks: malformed / failed evaluations resolve successfully so the surrounding chain can continue
- [ ] Today the chain runs ONE round; the multi-iteration fix-and-reeval loop is a documented follow-up
- [ ] Used standalone by `ralphctl sprint evaluate` and embedded inside the per-task chain

### Feedback

- [ ] `createFeedbackFlow(deps, opts)` returns an `Element<FeedbackCtx>`
- [ ] Step trace: `load-sprint → apply-feedback → check-scripts-feedback → record-feedback-iteration`
- [ ] Feedback is its own chain, not embedded inside `executeFlow` — the CLI/TUI launches it as a separate session
      after `executeFlow` settles
- [ ] Empty feedback input exits the loop without spawning the AI
- [ ] Hard cap: `MAX_FEEDBACK_ITERATIONS` (owned by the launching CLI/TUI)
- [ ] Disabled by `--no-feedback` flag and implicitly by `--session` mode

### Onboard (interview-mode AI-assisted setup)

- [ ] `createOnboardFlow(deps, opts)` returns an `Element<OnboardCtx>`
- [ ] Step trace: `load-project → resolve-repo → run-onboard-ai → confirm-setup-script → confirm-verify-script →
  confirm-context-file → write-context-file → save-repo-scripts`
- [ ] A single AI session emits up to four artefacts via signals: `<setup-script>`, `<verify-script>`, `<agents-md>`,
      `<skill-suggestions>`
- [ ] Mode auto-detected per repo: `bootstrap` (no prior project context file), `adopt` (file present, no harness
      marker — preserve prose, propose additions only), `update` (harness marker `<!-- ralphctl onboard: <ISO> -->`
      present — prune + augment)
- [ ] Setup + verify scripts share a parser-level security denylist — pipe-to-shell, `curl … | sh`, `eval`,
      `rm -rf` variants are dropped at the boundary so an empty / missing signal is the canonical "no proposal"
- [ ] Provider-native target: `CLAUDE.md` for `aiProvider: claude`, `.github/copilot-instructions.md` for `copilot`.
      No symlinks, no pointer files
- [ ] Context file written with the harness marker `<!-- ralphctl onboard: <ISO> -->` on the first line so update
      mode can detect prior runs
- [ ] `Repository.markOnboarded(now)` persists `onboardedAt` on the repository entity after the chain settles
- [ ] `Repository.setupScript` and `Repository.checkScript` are persisted by `save-repo-scripts` after user
      confirmation
- [ ] `--auto` flag short-circuits the three confirm leaves (`autoAccept: true` in context); accepts the AI proposal
      as-is and works in non-interactive contexts
- [ ] `--dry-run` generates the proposal without writing any files
- [ ] CLI surface: `ralphctl project onboard <name> [--repo <path>] [--auto] [--dry-run]`
- [ ] TUI parity — `ProjectOnboardView` reachable from the home browse submenu (`b → Onboard a repo`) and from the
      project detail view (`o`)
- [ ] Project list / show + doctor surface onboarding status (pass / warn / skip)

### Create-PR (publish chain)

- [ ] `createCreatePrFlow(deps, opts)` returns an `Element<CreatePrCtx>`
- [ ] Step trace: `load-sprint → assert-has-branch → derive-pr-content → create-pull-request → record-pr-url`
- [ ] `assert-has-branch` returns `InvalidStateError` when `sprint.branch === null`
- [ ] Detects `gh` vs `glab` from the git remote
- [ ] Persists `pullRequestUrl` on the `Sprint` entity via `SprintRepository.save()`
- [ ] CLI surface: `ralphctl sprint create-pr [id] [--base <ref>] [--draft] [--title …] [--body …]`
- [ ] TUI parity — sprint submenu has "Create PR / MR" entry under PUBLISH; pipeline-map's Close phase prefers
      Create PR over Close Sprint when active + all-done + branch + no-PR

## Composition root

- [ ] `createSharedDeps(overrides?)` (`application/bootstrap/shared-deps.ts`) constructs every concrete adapter
- [ ] `getSharedDeps()` / `setSharedDeps(deps)` / `resetSharedDeps()` (`bootstrap/get-shared-deps.ts`) are the
      singleton accessor + swap hook
- [ ] `getPrompt()` is the convenience accessor for the prompt port
- [ ] `FanOutLogger` over (auto-detected console sink, `JsonlSink`) so every log event hits both the user-facing
      surface and `<logsDir>/<sessionId>.jsonl`
- [ ] Console sink selected by `RALPHCTL_JSON=1` / non-TTY → `JsonLogger`; `logSink: 'ink'` → `InkSink` + `LogEventBus`;
      default → `PlainTextSink`

## Storage layout (live config, no snapshot)

- [ ] Storage root layout matches `ARCHITECTURE.md § Storage layout`: `config/`, `data/`, `cache/`, `logs/`, `backups/`
- [ ] Resolution lives in `src/integration/persistence/storage-paths.ts` (`resolveStoragePaths`,
      `ensureLayoutDirs`)
- [ ] `RALPHCTL_ROOT` overrides the root; defaults to `~/.ralphctl/`
- [ ] Config persists via `ConfigStorePort` (`application/config/config-store-port.ts`); `FileConfigStore` is the
      implementation
- [ ] Settings panel reads/writes via `ConfigStorePort` directly so mid-execution edits land on the next chain that
      reads config (live evaluation-config read is a documented follow-up — see Future Work)

## Harness signals

- [ ] Signal types are a fixed discriminated union in `src/domain/signals/harness-signal.ts`
- [ ] Adding a signal type requires a code change — the compiler enforces exhaustiveness via `_exhaustive: never`
- [ ] `<progress><summary>…</summary><files>…</files></progress>` parses to a `ProgressSignal`
- [ ] `<evaluation-passed>` / `<evaluation-failed>critique</evaluation-failed>` parses to an `EvaluationSignal` with
      status + dimensions
- [ ] `<task-verified>` / `<task-complete>` / `<task-blocked>` / `<note>` / `<check-script>` / `<agents-md>` all parse
      to their own typed variants
- [ ] Unrecognized or malformed signals log a warning and continue — no crash

## Harness-owned output writes

- [ ] The harness (never the AI agent) writes to `progress.md`, `evaluations/<taskId>.md`, and `tasks.json`
- [ ] Parsed `ProgressSignal`s append a timestamped markdown entry to `progress.md`
- [ ] Parsed `EvaluationSignal`s append full critique to `evaluations/<taskId>.md`; preview (≤2000 chars) mirrored on
      the `Task` entity
- [ ] Append-only writes — harness crash mid-write leaves prior entries intact (resumable)
- [ ] File locks (`FileLocker`) prevent concurrent corruption

## Project lifecycle

- [ ] Projects have unique slug names (`ProjectName` value object)
- [ ] Projects require at least one repository
- [ ] Repository paths are validated as existing directories
- [ ] Projects can be removed only if not referenced by tickets

## Sprint lifecycle

- [ ] New sprint starts as `draft`
- [ ] Only `draft` sprints can have tickets/tasks added
- [ ] `sprint start` auto-activates draft sprints
- [ ] Multiple sprints can be `active` at a time (parallel usage)
- [ ] Only `active` sprints can have task status updated
- [ ] `closed` sprints cannot be modified
- [ ] Sprint closure warns if tasks incomplete

## Ticket flow

- [ ] Tickets require `projectName` referencing existing project
- [ ] Tickets get auto-generated `TicketId`
- [ ] `requirementStatus` starts as `pending`
- [ ] `sprint refine` clarifies requirements (no code exploration)
- [ ] `sprint refine` sets `requirementStatus` to `approved`
- [ ] `sprint plan` proposes affected repos based on requirements
- [ ] `sprint plan` requires all tickets `approved`
- [ ] Repository selection saved to `ticket.affectedRepositories` during planning

## Incremental planning (Re-plan)

- [ ] `sprint plan` auto-detects existing tasks — no special flag needed
- [ ] When tasks exist, all tickets AND existing tasks are passed as AI context
- [ ] AI generates a complete task set (can modify, update, reorder, or add tasks)
- [ ] Imported tasks atomically replace all existing tasks via `TaskRepository.save`
- [ ] Re-plan stays draft-only — no active sprint relaxations
- [ ] Dependency reorder runs after every import

## Task execution

- [ ] Tasks execute in dependency order
- [ ] Independent tasks run in parallel (one per unique `projectPath`, default concurrency 4)
- [ ] `in_progress` tasks resume on restart
- [ ] Completion signals parsed correctly
- [ ] Blocked tasks pause execution for the affected task; the chain continues for other tasks
- [ ] `checkScript` runs at sprint start (per repo, idempotent via `sprint.checkRanAt`)
- [ ] `checkScript` runs after every task completion as a post-task gate
- [ ] Task not marked done if check gate fails
- [ ] Rate-limited tasks auto-resume via session ID; `RateLimitCoordinator` pauses new task launches globally

## Evaluator pattern

- [ ] Evaluator runs after task completion + check gate pass (not on check failure)
- [ ] Evaluator uses model ladder (Opus→Sonnet, Sonnet→Haiku, Haiku→Haiku)
- [ ] Copilot evaluator spawns without model override (no model control)
- [ ] `evaluationIterations` config controls max evaluation rounds; default fallback `1`, `0` disables
- [ ] Inside the per-task chain, the evaluator runs via `EvaluateAndFixLoopUseCase` for up to
      `evaluationIterations` rounds, with plateau detection and previous-critique injection
- [ ] Standalone `sprint evaluate` runs ONE round per invocation
- [ ] Evaluator **never blocks** — task always proceeds to `done` (or `blocked` via mark-blocked when branch-preflight
      fails), even on `failed` / `malformed` outcomes; full critique persists to `evaluations/<taskId>.md`
- [ ] `--no-evaluate` flag skips evaluation for a single run
- [ ] Session/interactive mode disables evaluation
- [ ] `evaluationOutput` truncated to 2000 chars before persisting on the `Task` entity
- [ ] `evaluated` field set to `true` after evaluation runs
- [ ] Evaluator grades the four floor dimensions on every task (Correctness / Completeness / Safety / Consistency)
- [ ] Tasks may carry an optional `extraDimensions: readonly string[]` emitted by the planner
- [ ] Extra dimensions render as additional `**Dimension N — <Name>**` blocks in the evaluator prompt
- [ ] `extraDimensions: undefined` means floor-only — no extra blocks rendered, no orphan placeholders

## Live config read (REQ-12)

- [ ] `LiveConfigReader` (`src/application/runtime/live-config-reader.ts`) re-reads `Config` fresh on every call
- [ ] `FileLiveConfigReader.current()` falls back to `CONFIG_DEFAULTS` on transient store errors
- [ ] The per-task chain calls `reader.current()` per task settlement so `evaluationIterations` edits via the
      settings panel land on the next task without restart
- [ ] Settings panel saves directly via `ConfigStorePort.save()`; no snapshotting at sprint-start time

## Mark-blocked task status

- [ ] `Task.status` union: `'todo' | 'in_progress' | 'done' | 'blocked'`
- [ ] `Task.markBlocked(reason)` rejects from `done` and `blocked`; allowed from `todo` or `in_progress`
- [ ] `Task.unblock()` clears `blocked → todo` and wipes `blockedReason`
- [ ] Branch-preflight failure inside the per-task chain falls back to `markBlocked` via `OnError`, not a chain abort
- [ ] `Task.blockedReason` populated when `markBlocked` runs; cleared by `unblock`

## Branch management

- [ ] `sprint start` prompts for branch strategy on first run (keep current, auto, custom)
- [ ] `--branch` flag auto-generates `ralphctl/<sprint-id>` branch name
- [ ] `--branch-name <name>` sets a custom branch name
- [ ] Branch is created in all repos with remaining tasks
- [ ] Uncommitted changes in any repo fail-fast before branch creation
- [ ] Branch name persisted to `sprint.branch` for resume
- [ ] Subsequent runs skip prompt and use saved branch
- [ ] Pre-flight branch verification before each task execution (handled by the `branch-preflight` step in the per-task
      chain)
- [ ] `sprint show` displays branch when set
- [ ] `sprint health` checks branch consistency across repos
- [ ] `sprint close --create-pr` creates PRs for sprint branches
- [ ] Agent context includes branch section telling agent which branch it's on

## Repo onboarding

- [ ] `ralphctl project onboard <name>` works interactively (Ink TUI) and headlessly (`--auto`)
- [ ] Writes the **provider-native** project context file: `CLAUDE.md` for `claude`,
      `.github/copilot-instructions.md` for `copilot`. No symlinks, no pointer files.
- [ ] Never overwrites an authored project context file without the user's consent — adopt mode treats the existing
      body as authoritative
- [ ] Works across ecosystems — Node, Python, Go, Rust, Java, Makefile, polyglot
- [ ] `--dry-run` generates the proposal without writing files
- [ ] `--auto` skips interactive review (accepts the AI proposal as-is) and works in non-interactive contexts

## Doctor (environment health)

- [ ] Checks Node.js version >= 24.0.0
- [ ] Checks `git` is installed and in PATH
- [ ] Warns (not fails) when git identity (`user.name`/`user.email`) is missing
- [ ] Checks configured AI provider binary (`claude` or `copilot`) is in PATH
- [ ] Skips AI provider check when no provider is configured
- [ ] Verifies data directory is accessible and writable
- [ ] Validates all registered project repository paths exist and are git repos
- [ ] Validates current sprint file exists and parses correctly
- [ ] Skips sprint check when no current sprint is set
- [ ] Sets non-zero exit code on failures (warnings don't affect exit code)
- [ ] Checks live in `src/application/doctor/checks/` — one file per check; `run-doctor.ts` orchestrates

## Multi-project support

- [ ] Projects can have multiple repositories
- [ ] Tickets reference projects by name (`ProjectName` value object)
- [ ] Tasks get `projectPath` from the ticket's project (`AbsolutePath` value object)
- [ ] Each task executes in its assigned project path

## Terminal UI (Ink TUI)

- [ ] Bare `ralphctl` mounts the Ink-based REPL on TTY environments via
      `src/application/tui/runtime/mount.tsx`
- [ ] `ralphctl interactive` mounts the same REPL explicitly
- [ ] Non-TTY / piped stdout / `CI=1` / `RALPHCTL_JSON=1` / `RALPHCTL_NO_TUI=1` disables Ink and falls back to plain
      text
- [ ] In-TTY menu selections dispatch to the matching command/view and return to the menu afterwards
- [ ] Pressing `s` from any view opens the settings panel overlay; Esc closes it
- [ ] Pressing `d` from any view opens the dashboard
- [ ] `q` exits the REPL from home root; Ctrl+C cancels the currently pending prompt
- [ ] Tab / Shift+Tab cycles foreground/background sessions; `Ctrl+1..9` direct-jumps
- [ ] One-shot CLI commands (`sprint show`, `config show`, `project list`, etc.) never mount the full Ink TUI

## Live execution dashboard

- [ ] `ralphctl sprint start <id>` on TTY mounts the Ink dashboard and starts execution automatically
- [ ] Task grid renders one row per task with status indicator, name, and project path
- [ ] Progress signals update the "current activity" line for the originating task in real time
- [ ] Parallel task statuses update independently per task
- [ ] Rate-limit pause/resume events render a banner; banner disappears when the coordinator resumes
- [ ] A rolling log tail shows the most recent events (default 200-event cap)
- [ ] Execution completion shows summary counts (`completed`, `remaining`, `blocked`)
- [ ] When all tasks finish successfully, user is prompted via the Ink confirm component whether to close the sprint
- [ ] Non-TTY fallback runs the same chain with `PlainTextSink` output (no React)

## Settings panel

- [ ] Rows iterate `CONFIG_ROWS` in `src/application/config/config-schema-rows.ts` — adding a row is a single edit
- [ ] Each row shows the key, current value, and one-line description
- [ ] Per-row prompt kind is determined by value type (`select` / `confirm` / `input`)
- [ ] Inline validation errors render below the row until the value is fixed
- [ ] Valid edits save immediately via `ConfigStorePort.save()` — no explicit "save" action
- [ ] Panel is accessible during sprint execution (`s` key); edits land on the next task via `LiveConfigReader`
- [ ] Esc closes the panel and returns to the underlying view

## Persistent banner + help modal

- [ ] `<Banner />` renders on every TUI view via `<ViewShell />`, not only Home
- [ ] The banner quote stabilises at module load (`STABLE_QUOTE` in `components/banner.tsx`) — re-renders do not
      reroll the quote
- [ ] `?` opens `<HelpOverlay />`; the router renders ONLY the overlay when `isHelpOpen` (view tree, prompt host,
      hints, status bar all suspended)
- [ ] Esc and `?` close the overlay and restore the underlying view
- [ ] Help overlay rows are generated from `KEYBOARD_MAP` — adding a binding surfaces in the overlay automatically
- [ ] `!` opens the doctor view from anywhere

## Centralised keyboard map

- [ ] All TUI shortcuts live in `src/application/tui/keyboard-map.ts`
- [ ] Areas: `global / home / list / detail / execute / attach / runs / settings / help / notification`
- [ ] Within one area, no two actions share a key
- [ ] Global bindings shadow non-global areas — no non-global action may reuse a global key for a different action
- [ ] Each `Action` key in the union is present in the map (structural test fence)
- [ ] `getKeyFor(action)` returns the canonical (first) key; aliases are allowed (e.g. `↑` / `k` both bound to
      `list.up`)

## Pipeline map + tiered submenus

- [ ] Home renders `<PipelineMap />` with four phase rows (Refine / Plan / Execute / Close) plus a bright
      "Next step" quick-action row anchored above the spine
- [ ] The quick-action row pre-selects the current phase's primary action; bare Enter does the right thing
- [ ] `b` from Home opens the browse submenu; submenus drill into Sprint / Ticket / Task / Project groups
- [ ] Menu actions are typed via `MenuAction` discriminated union (`route` / `launchChain` / `subMenu` / `back`);
      no string-encoded routing
- [ ] Pipeline-map's Close phase prefers Create PR over Close Sprint when active + all-done + branch + no-PR

## Prompt transcript

- [ ] Resolved prompts render dim above the live prompt as a transcript history
- [ ] History clears when the prompt queue idles past `SEQUENCE_IDLE_MS = 100ms`
      (`src/integration/ui/prompts/prompt-queue.ts`)
- [ ] Per-prompt-kind value renderers live in `prompt-transcript.tsx`

## Doctor view

- [ ] `<DoctorView />` runs `runDoctor()` on mount
- [ ] Renders one row per check (status indicator + label + finding)
- [ ] Aggregate `<ResultCard kind="success" | "warning" | "error" />` summarises the run
- [ ] `!` global hotkey opens it from any view
- [ ] Onboarding-status check reports per-(project, repo) status: pass / warn / skip

## Progressive chain trace

- [ ] `ChainRunner.subscribe` emits `step` events progressively as each leaf settles, not as an end-of-run replay
- [ ] The kernel passes an `onTrace` callback through `Sequential` / `Parallel` / `Retry` / `OnError`
- [ ] Late subscribers attached after the runner reaches a terminal state still receive a synthetic replay
      (`step*` then the terminal event)
- [ ] Listener errors in one subscriber never stall delivery to others

## Restored CLI commands (Run B)

- [ ] `ralphctl completion install [--shell bash|zsh|fish]` — auto-detects shell from `$SHELL` when omitted
- [ ] `completion install` is idempotent (marker comment prevents duplicate appends)
- [ ] `completion show [--shell …]` prints the completion script to stdout
- [ ] Completion script invokes `ralphctl completion --` with `COMP_*` env vars; the entrypoint intercepts before
      the TUI mount path
- [ ] `ralphctl sprint progress [id] [--log] [--lines <n>]` replaces legacy `sprint health`; folds blockers + stale
      tasks + dependency cycles + branch consistency into the progress view
- [ ] TUI parity — `ProgressView` reachable from the sprint submenu (BROWSE → Progress)
- [ ] `ralphctl sprint requirements [id] [--output <path>]` exports refined requirements to markdown
- [ ] `ralphctl sprint context [id] [--output <path>]` exports the full harness context to markdown
- [ ] Both export commands default to `./<sprintId>-{requirements,context}.md` when `--output` is omitted; accept
      absolute or relative paths
- [ ] TUI parity — sprint submenu EXPORT section has Requirements + Context entries; the views prompt for output
      path via `getPrompt()`

## CRUD round-out

- [ ] `SprintEditUseCase` updates name and / or branch on a draft / active sprint
- [ ] `SetCurrentSprintUseCase` rewires `Config.currentSprint` to the chosen sprint id
- [ ] `EditTaskUseCase` updates name / description / steps / verificationCriteria / blockedBy / projectPath /
      extraDimensions; rejects edits on non-`todo` tasks
- [ ] Standalone `TicketApproveView` and `TicketAssignReposView` exist as TUI views, separate from `sprint refine` /
      `sprint plan` chains
- [ ] Entity transitions: `Sprint.rename(name)`, `Sprint.clearBranch()`, `Sprint.recordPullRequestUrl(url)`,
      `Repository.markOnboarded(now)` / `clearOnboarded()`, `Task.update(input)`
- [ ] Form views retry on validation errors instead of dumping back to home: sprint-create / project-add / ticket-add
      / task-add / sprint-edit / project-edit

## Onboarding visibility

- [ ] Project list view shows `N/M onboarded` per project
- [ ] Project show view shows per-repo `onboarded YYYY-MM-DD` or `not onboarded`
- [ ] Doctor reports per-(project, repo) onboarding status
- [ ] Top-level "Onboard a repo" entry under SYSTEM in the browse menu (`b → Onboard a repo`, two keys from anywhere)

## Inline text editor (Claude-Code style)

- [ ] Multi-line text input renders bottom-anchored inline — no external editor spawn
- [ ] Ctrl+D submits; Esc or Ctrl+C cancels (resolves to `null`)
- [ ] Enter inserts a newline in the buffer
- [ ] Left/Right/Up/Down keys move the cursor across lines and columns
- [ ] Ctrl+A jumps to start of line; Ctrl+E jumps to end of line
- [ ] Backspace/Delete remove the character before/at cursor; merges with previous line when at column 0
- [ ] Pasted multi-character chunks are split on `\n` and inserted as new lines at the cursor

## Prompt abstraction (PromptPort)

- [ ] All call sites use `getPrompt()` from `src/application/bootstrap/get-shared-deps.ts` — no direct
      `@inquirer/prompts` imports anywhere
- [ ] `PromptPort` interface lives in `src/business/ports/prompt-port.ts`; application-side type re-export at
      `src/application/ui/prompt-port.ts`
- [ ] `InkPromptAdapter` (`src/integration/ui/prompts/prompt-adapter.ts`) is the only implementation; one-shot
      CLI commands auto-mount a minimal `<PromptHost />` on demand (`auto-mount.tsx`)
- [ ] `select` / `confirm` / `input` / `checkbox` throw `PromptCancelledError` on Ctrl+C / Escape
- [ ] `editor` / `fileBrowser` return `null` on cancel
- [ ] Parallel prompts queue serially — only the head prompt renders; others wait in FIFO order

## Signal bus & observability (SignalBusPort)

- [ ] Per-task chain emits on every parsed signal, rate-limit pause/resume, and task lifecycle event
- [ ] `InMemorySignalBus` micro-batches emissions within ~16ms (one animation frame) to prevent render storms
- [ ] `FileSystemSignalHandler` (durable writes) and the Ink dashboard both subscribe — two sinks, one source
- [ ] Subscribers receive events in emission order
- [ ] Listener errors in one subscriber never stall delivery to others
- [ ] `dispose()` on shutdown drains buffers and drops subscribers

## Logger sinks (LoggerPort)

- [ ] `PlainTextSink` on TTY one-shot CLI — ANSI-colored, human-readable stdout
- [ ] `JsonLogger` on non-TTY / piped / CI — one JSON object per line with `{level, message, timestamp, ...context}`
- [ ] `InkSink` when Ink is mounted — publishes to the log event bus; never writes stdout directly
- [ ] `JsonlSink` writes every log entry to `<logsDir>/<sessionId>.jsonl` for post-hoc debugging
- [ ] `FanOutLogger` wraps console + JSONL sinks so every log entry lands in both
- [ ] `RALPHCTL_LOG_LEVEL=debug|info|warn|error` filters output in every sink
- [ ] Test environment (`VITEST=1`) silences info / warn output automatically

## Build & verification

- [ ] `pnpm typecheck && pnpm lint && pnpm test` passes at every commit
- [ ] Doctor reports green on a fresh install with the `~/.ralphctl/` layout
- [ ] Every chain definition has an integration test asserting `trace.map(s => s.stepName)` for happy + failure paths
- [ ] Every kernel primitive has unit tests in isolation; business depends only on tested kernel parts

---

# UI Contract

The contract every TUI view follows. Goal: the app feels written from one hand — same layout, same keys, same
language on every screen. Changes to TUI primitives MUST update this section.

> **Full design system:** [DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md) is the canonical reference — tokens, component
> inventory, state surfaces, copy rules, anti-patterns, and the "when to extend vs reuse" ladder. This section holds
> the **testable** version of that system.

## Design intent — "Technical Letterpress"

Typography is the workhorse: bold + dim carry hierarchy, color carries semantic state. Ralph personality is
concentrated in the banner, not smeared across every view. Glyphs are a curated, consistent family — ■ ◆ ◇ ▸ ▣ ━ │ ↳ ◌
and the braille spinner.

## Anatomy of a view

Every view mounts through `<ViewShell>` (`src/application/tui/components/view-shell.tsx`):

```
┌─ ViewShell ─────────────────────────────────────┐
│  <SectionStamp title="VIEW TITLE" />            │ ← header (always)
│                                                 │
│  <body>  ← the view-specific content            │
│                                                 │
│  <PromptHost />  ← inline prompts (auto)        │
│                                                 │
│  <KeyboardHints />  ← view-local hints (auto)   │
└─────────────────────────────────────────────────┘
<StatusBar>  ← owned by the router (breadcrumb + global hotkeys)
```

Views never render their own header box, spacing boxes between sections, or hint footer. `ViewShell` owns all three.

## Keyboard contract

**Global hotkeys** — owned by the router (`src/application/tui/views/use-global-keys.ts`), work from EVERY view:

- `Esc` — pop one frame (no-op at root)
- `h` — home
- `s` — settings
- `d` — dashboard
- `Tab` / `Shift+Tab` — foreground next / previous session
- `Ctrl+1..9` — direct-jump to N-th session
- `q` — quit (home root only)

**View-local keys** — declared via `useViewHints()`. Common vocabulary:

- `↑/↓` — move cursor
- `←/→` — switch panes / previous/next page
- `Enter` — confirm / open / run
- `Space` — toggle / multi-select
- `Tab` / `Shift+Tab` — next / prev field (inside forms; the global session-cycle takes priority outside form mode)
- `Ctrl+D` — submit multi-line editor
- A single letter (`b`, `r`, `n`, `k`, …) — primary view action, always shown in hints

**Rules:**

- Any undocumented key is a bug. If a view responds to it, hint for it.
- `Enter` on a terminal/result state pops the view.
- `Esc` in a submode returns to the parent mode before being claimed by the router.

## Navigation

- **Workflow views** (add / edit / remove / configure): use the `useWorkflow` hook
  (`src/application/tui/components/use-workflow.ts`). Phase discriminator drives spinner + result card. Enter on
  terminal → pop.
- **List views** (`browse/*-list-view.tsx`): `ListView` with `↑/↓ · Enter open · Esc back`.
- **Detail views** (`browse/*-show-view.tsx`): `FieldList` + `StatusChip` for metadata.
- **Phase views** (refine / plan / close / execute): behave like a workflow view — `<SectionStamp>`, `useWorkflow`-
  compatible state machine, `<ResultCard>` for the outcome. No bespoke input handlers.

## Prompts

- Always go through `getPrompt()` — no direct Ink input components in a view.
- `<PromptHost>` renders inside `<ViewShell>` between body and hints — `ViewShell` owns placement.
- Multi-step forms: set `phase.step` before each prompt so the spinner reflects what the user is answering.

## Spinner labels

Imperative, ends with a single ellipsis. Reserve the verb for the _action the harness is performing_, not what the
user is about to do.

- Do: `Loading sprints…` / `Saving ticket…` / `Fetching issue data…` / `Generating tasks…`
- Don't: `Type the title…` (that's a prompt hint, not a spinner state)

When the view is idle waiting on a prompt, don't show a spinner. Show the prompt.

## States — one surface per kind

| State                   | Surface                         | Notes                                      |
| ----------------------- | ------------------------------- | ------------------------------------------ |
| Loading / running       | `<Spinner label="…" />`         | Warning color default; never bare text     |
| Empty (no data to show) | `<ResultCard kind="info" />`    | "No X yet" with a `nextSteps` pointer      |
| Precondition failed     | `<ResultCard kind="warning" />` | "Needs Y first" with a `nextSteps` pointer |
| Error                   | `<ResultCard kind="error" />`   | Carry `lines={[message]}`                  |
| Success                 | `<ResultCard kind="success" />` | `fields={…}` + `nextSteps={…}`             |

Never mix raw `<Text color="red">` with `ResultCard`. Pick a surface.

## Layout tokens

Every `marginTop` / `marginBottom` / `padding*` value must come from `tokens.spacing`
(`src/integration/ui/theme/tokens.ts`):

- `spacing.section` — vertical gap between sections (= 1)
- `spacing.indent` — left-indent for nested content (= 2)
- `spacing.gutter` — padding inside card-like boxes (= 1)

No hardcoded numbers. ViewShell already spaces header → body → hints correctly; views only add spacing inside their
body.

## Glyphs

All symbols come from `tokens.glyphs`. Never inline a unicode character.

Canonical set:

- `phaseDone` (■), `phaseActive` (◆), `phasePending` (◇), `phaseDisabled` (◌)
- `actionCursor` (▸), `selectMarker` (›)
- `badge` (▣), `sectionRule` (━)
- `check` (✓), `cross` (✗)
- `warningGlyph` (⚠), `infoGlyph` (i)
- `inlineDot` (·), `emDash` (—), `arrowRight` (→), `activityArrow` (↳)
- `separatorVertical` (│)
- `spinner` (braille frames), `quoteRail` (┃)

## Colors

Semantic only. Never `color="red"` — always `inkColors.error`.

Palette lives in `inkColors` (`src/integration/ui/theme/tokens.ts`):

- `success` (sage) — completion, pass, done
- `error` (coral) — failure, blocked, fail
- `warning` (amber) — in-progress, draft, paused
- `info` (dusty cyan) — annotations, meta, help
- `muted` (warm gray) — secondary, inactive, disabled
- `highlight` (mustard) — focus, selection, "next" marker
- `primary` (mustard) — brand accent (section stamps)
- `secondary` (rose) — personality (quote rail)

**Focus pattern:** `{ color: inkColors.highlight, bold: true }` — apply inline; there is no shared `focus` token.

## View-hints contract (`useViewHints`)

Each view declares its keys once:

```tsx
useViewHints([
  { key: '↑/↓', action: 'move' },
  { key: 'Enter', action: 'open' },
  { key: 'b', action: 'browse' },
]);
```

Hints render in `<KeyboardHints />` at the bottom of `<ViewShell>`. The StatusBar only ever shows _global_ hotkeys.

## Surfaces

- **Home** — the only screen that renders the Banner + sprint summary. Every other screen is a plain `<ViewShell>` —
  no banner, no hero. Keeps navigation cheap.
- **Dashboard** — read-only status destination. Shows task grid, blockers, sprint summary hero. `d` from anywhere.
  Escape pops back.
- **Execute** — live dashboard during sprint execution. Subscribes to `SignalBusPort` + log event bus. `s` still
  pushes settings on top.
- **Sessions** — multi-chain switcher. Lists every runner with status + age. ↑/↓ navigate, Enter foreground, k kill.
- **Settings** — schema-driven rows. Editing a field saves immediately via `ConfigStorePort.save()`. Esc closes.

## Non-negotiables

- No view writes to `console.log` / stdout directly. Use the injected `LoggerPort`.
- No view calls a use case directly. Use chain factories from `application/chains/<workflow>/` and launch via
  `SessionManager.start(...)`.
- No view mounts a prompt outside `getPrompt()`.
- No view renders its own hint footer. Use `useViewHints()`.
- `pnpm typecheck && pnpm lint && pnpm test` must pass at every commit.
