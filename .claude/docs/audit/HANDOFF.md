# Handoff — Implementing the audit

You are picking up an audit of the harness's output / observability / AI-contract
surface. The work is **target-state-coherent and ready to implement**. This file
tells you how to start.

## What you're looking at

`.claude/docs/audit/` contains 11 islands (`01..11`) + this handoff + a `README.md`
index. Each island is a self-contained design note: status, decisions, action
items, evidence. The README's "Index" table tells you what each island covers;
the "Suggested implementation order" tells you the dependency-aware sequence.

**The audit describes the target state, not the current state.** Where action
items reference src/ paths, the implementer (you) grep the real codebase to find
the actual location. Some hints may have drifted. Reality is canonical; the docs
describe what should be true after the work.

## Read in this order (15 minutes)

1. **`README.md`** — index, glossary, working conventions, the 9-step suggested order.
2. **`09-ai-session-contract.md`** — the most consequential change. Read fully.
3. **`07-progress-vs-chain-log.md`** — append-only journal model + deletions.
4. **`01-logs-directory-layout.md`** — `<sprintDir>/` layout target.
5. Skim **`02`, `03`, `04`, `05`, `06`, `08`, `10`, `11`** — each is ~5 minutes.

After this you should be able to predict, for any sprint dir, where each file
lives, who writes it, and what shape its content has.

## Start here (concrete first commit)

The 9-step order in `README.md` is dependency-correct. **Step 1 is [04]** — the
setup-script lifecycle gate. It's small, has no upstream dependencies, lands a
real user-facing improvement, and proves the audit's pattern works.

### Step 1 — Land [04] (setup-script lifecycle)

```bash
# 1. Read the island
cat .claude/docs/audit/04-setup-script-failure.md

# 2. Locate the leaf
grep -rn "setupScriptRunnerLeaf" src/

# 3. Verify the audit's claims against reality (this is the canonical step the
#    audit can't do for you — the file paths in actions may have drifted)
grep -rn "setupRanAt" src/domain/entity/

# 4. Implement the gate as described in the island's pseudo-code section
# 5. Add the unit tests listed in the island's action items
# 6. Run /verify (or pnpm typecheck && pnpm lint && pnpm test)
# 7. Commit per the project's conventional-commits style (see git log for tone)
```

When this lands and `/verify` is green, move to step 2.

### Step 2 — Land the [09] foundation (no flows touched)

Foundation = the new module tree under `src/integration/ai/contract/_engine/`.
Files: `types.ts`, `validate-signals-file.ts`, `render-sidecars.ts`,
`render-contract-section.ts`, `render-evaluation-markdown.ts`, plus per-signal
Zod schemas under `signals/<kind>/schema.ts`. Plus the `AiSignal` TS-only
rename in `domain/signal.ts`.

No leaf is migrated yet. No prompt is updated yet. The new files are
declared-but-not-yet-used. Existing parser stays.

`/verify` must stay green.

### Steps 3+ — Continue per README's order

3. [11] prompt template tests (lands before prompts change so we catch drift)
4. [10] mock AI provider + fixture helpers
5. [09] per leaf — generator → evaluator → refine → plan → ideate → readiness
6. [07] journal model — only possible once every leaf has migrated
7. [01] + [06] — paired: logs/ directory + JSON slimming + per-entity migrations
8. [03] — display-clip sweep
9. [05] + [08] — documentation polish

Each step lands behind `/verify` going green. Each step is a single PR.

## Working conventions to respect

### From `CLAUDE.md` (project root)

- Four-module Clean Architecture: `domain → business → integration → application`. Inner cannot import outer. Domain and business cannot import I/O-bearing `node:*` modules.
- Function-first: use cases are factory functions returning `{execute(input)}`. No `class` outside `src/domain/value/error/`. No `this`.
- No barrel files (`export *` banned anywhere under `src/`).
- Result types from `@src/domain/result.ts` for every business operation.
- Atomic file writes via `business/io/write-file.ts` (and the new `AppendFile` port from [07]).
- Port-shaped interfaces (`*Port`, `*Adapter`, `*Provider`, `*Sink`, `*Loader`, `*Probe`, `*Contract`) MUST live in `_engine/` under their sibling-isolation directory.
- `AbortError` is the one error that propagates transparently — guards / fallbacks MUST exempt it.

### From this audit

- The audit is the source of truth for **target state**. Conflicts with current code → fix the code, not the audit.
- New evidence that contradicts a decided island reopens it. Append an "Update YYYY-MM-DD" block; don't rewrite history.
- ESLint fences listed in [09] must land before the patterns they protect can be relied on.

## Verification gates

Per CLAUDE.md, `/verify` (`pnpm typecheck && pnpm lint && pnpm test`) must pass
before every commit. This is non-negotiable; the pre-commit hook enforces it.

After each step in the implementation order, you should additionally verify:

| Step                | Smoke test                                                                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 ([04])            | Create a new sprint with a setup-script configured to `false`. Run implement. Confirm hard abort. Resume — confirm setup skipped, banner says "skipped on resume."                 |
| 2 ([09] foundation) | New files compile; `/verify` green; no leaf yet calls into them.                                                                                                                   |
| 3 ([11])            | Add a test that breaks an existing template's placeholder/parameter parity; ESLint rule + test should both flag.                                                                   |
| 4 ([10])            | Mock provider helper compiles; one example test using it passes.                                                                                                                   |
| 5 ([09] per leaf)   | Per leaf: real Claude / Copilot / Codex spawn writes `signals.json` validating against the leaf's `AiOutputContract`.                                                              |
| 6 ([07])            | Run an implement chain; `<sprintDir>/progress.md` grows with one `## Task: <name> — Attempt <N>` section per settle. No `chain.log` / `decisions.log` on disk.                     |
| 7 ([01] + [06])     | `<sprintDir>/logs/{setup,verify}/` populated with untruncated outputs. `execution.json` / `tasks.json` carry no `stdoutTailBytes` fields. Old sprints still load (migration runs). |
| 8 ([03])            | grep `SCRIPT_TAIL_BYTES` and `SINK_BODY_CAP` — gone. Banner clip still works.                                                                                                      |
| 9 ([05] + [08])     | TUI's `e` hotkey on a task renders criteria from `Task.verificationCriteria` (no async file read).                                                                                 |

## When you get stuck

- **Path mismatch in an action item** — grep the real codebase. The audit may name `business/observability/state-projection.ts` but reality is `business/sprint/state-projection.ts`. Trust your grep.
- **A design choice not covered** — read the island's "Resolved" section; if still unclear, the user's preference is the lint-over-scaffold, simpler-over-clever, observe-over-mutate style. Pick accordingly and note it in the island as an "Update YYYY-MM-DD" block.
- **An invariant from CLAUDE.md seems blocked by the audit** — the audit's design tried to respect every invariant; if you find a true conflict, stop and surface it. Don't soften the invariant.
- **The user provides new direction mid-stream** — that may reverse a prior decision. Surface the reversal explicitly before patching (see `feedback_flag_conflicts.md` in user memory).

## What the audit deliberately doesn't cover

- Exact current src/ paths for deletion / modification targets (you grep)
- Exact ESLint rule body code (you write it; the audit specifies the invariant)
- Exact Zod schemas per signal kind (the audit specifies the TS shape; you write the Zod)
- Migration step bodies (`{ 0: (raw) => …, 1: (raw) => …, … }` are sketched, not finished — write them as you ship each schema bump)
- Test bodies (the audit specifies the test grid in [10] / [11]; you write the cases)

Good hunting.
