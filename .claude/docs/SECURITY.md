# Security & Safety

> On-demand reference (split out of `CLAUDE.md`). Read when touching the permission model, the
> cross-process lock, process spawning, skills, refine write-back, or the file-based provider contract.

**Permission model — two orthogonal axes.** `SessionPermissions` gates **capabilities**
(`canModifyRepoFiles`, `canRunShell`, `canAccessNetwork`, `autoApprove`); `cwd` +
`additionalRoots` + `outputDir` on the `AiSession` define **topology** (which paths the AI
can read / write). Topology is the primary defense; capabilities are the secondary filter.

The `Write` tool is **always allowed** under every profile — the audit-[09] contract requires
the AI to land `signals.json` in `outputDir`. To deny writes to a tree, don't mount it.
`outputDir` is auto-included as a writable root in every provider (see
`providers/_engine/resolve-roots.ts`).

| Provider         | Always passes                                       | Read-only profile maps to                            | Native context file               |
| ---------------- | --------------------------------------------------- | ---------------------------------------------------- | --------------------------------- |
| `claude-code`    | `--permission-mode bypassPermissions`               | `--disallowedTools Edit,MultiEdit,NotebookEdit,Bash` | `CLAUDE.md` at repo root          |
| `github-copilot` | `--no-ask-user --autopilot --silent`                | `--allow-all-tools --deny-tool=shell`                | `.github/copilot-instructions.md` |
| `openai-codex`   | `-s workspace-write` (no `-a` flag)                 | `-s workspace-write` (topology-scoped)               | `AGENTS.md`                       |
| `opencode`       | `run --format json --dir <cwd> -m <provider/model>` | **nothing — no argv spelling exists**                | `AGENTS.md`                       |

Codex caveat: `codex exec` has only two sandbox modes (`read-only` / `workspace-write`), and
`read-only` blocks every write (incl. signals.json). Every profile maps to `workspace-write`;
Codex can't fine-grained-deny edits on existing repo files. Use topology to constrain it.

OpenCode caveat (stronger): `opencode run` exposes exactly ONE approval control, `--auto`, and
omitting it does NOT make the session read-only — a plain `run` still executes write and edit
tools without prompting (verified against v1.18.15). There is therefore no argv spelling of
`canModifyRepoFiles: false` at all; path topology is the only boundary. Plainly stated: OpenCode
has no flag to grant write access to just one extra directory — permission is all-or-nothing
(`--dir` sets a single root, and its `external_directory` permission auto-REJECTS access outside
that root). ralphctl's `outputDir` (where `signals.json` lands) routinely sits outside the project
folder, so whenever `outputDir` / `additionalRoots` fall outside `cwd` the adapter emits `--auto`
to clear that gate wholesale — without it the AI would sit blocked waiting for an
external-directory approval that never arrives. In practice `--auto` is therefore passed on
effectively every headless run, and the project/session directory is the real safety boundary, not
the CLI's permission gate — exactly as already documented above for OpenAI Codex. The
precise-scoping follow-up is OpenCode's config-level `permission.external_directory` map, which can
allow specific paths instead — it needs a generated per-session config file and is deliberately not
wired in the first adapter. See `providers/opencode/headless.ts` for the full note. One clarification
worth keeping in mind when reading that flag: `--auto` promotes the tool classes an operator set to
`ask`, but per OpenCode's permissions documentation it does not override a class set to `deny` — an
explicit denial in the operator's `opencode.json` stays enforced.

The `readiness` flow fans out across every uniquely referenced provider in `settings.ai` — one native
context file per provider (claude-code → `CLAUDE.md`, github-copilot → `.github/copilot-instructions.md`,
openai-codex → `AGENTS.md`, opencode → `AGENTS.md`). Single-provider configurations produce exactly one
file; mixed configurations produce one file per distinct native context file — `openai-codex` and
`opencode` share the repo-root `AGENTS.md`, so a config naming both runs two readiness passes over that
same file (the second overwrites it, preserving the first pass's output verbatim in a
`<path>.bak.<timestamp>` copy). No symlinks, no pointer schemes. Don't introduce either.

**Cross-process advisory lock** at `<stateRoot>/locks/repo-<hash>.lock` (sha1 of the repository worktree
path, first 16 hex) serializes whole-flow runs against one working tree so two ralphctl processes can't race
the same repo. Backed by `proper-lockfile` (`file-locker.ts`): the lock is a directory (atomic `mkdir`,
NFS-safe) kept fresh by a background heartbeat, so a LIVE holder is never falsely stolen no matter how long
the run lasts — a crashed holder stops heartbeating and is reclaimed once its mtime passes `staleAfterMs`
(default 30s, clamped 2000–3600000 ms; bounds crash-reclaim latency only). Not env-configurable. A held lock
lost mid-run (`onCompromised`) surfaces a `lock-compromised` warning AND aborts the in-flight run: the
lock-compromised signal is merged into the chain's abort signal (`combineAbortSignals`), so a lost lock tears
the run down as an `AbortError` instead of continuing to mutate a resource a competitor may now own. The lock
is held across the whole run by the implement flow (serial path via `withRepoLock`, parallel path holds the
key directly) and by the review flow (`withRepoLock`, same sprint-dir key — implement and review of one
sprint mutually exclude). `withRepoLock` (`flows/_shared/`) is the one ctx-generic wrapper both use.

**Atomic file writes** via `business/io/write-file.ts` for all persisted state. Direct `fs.writeFile` is
fenced from business code by the layer rules.

**Cross-platform process spawning** goes through `integration/io/cross-platform-spawn.ts`
(`crossPlatformSpawn`, backed by `cross-spawn`) — the single primitive every external-CLI spawn
(`claude` / `codex` / `gh` / `glab` / `git`, headless + interactive) delegates to, including
`clipboard.ts` and `command-exists.ts`. Never call `node:child_process.spawn` directly for a
binary: on Node 24 Windows a bare spawn cannot launch the npm/winget `.cmd` shims, and
`shell: true` mis-quotes arguments with spaces or `& | % "`. There are two named exceptions: the
setup/verify-script runner (`shell-script-runner.ts`), which intentionally keeps `shell: true`
because it runs a user-authored command _string_, not a binary + args; and
`os-notification-dispatcher.ts`, which uses promisified `execFile` for its buffered-stdout,
reject-on-nonzero semantics against `osascript` / `notify-send` / `which`. An ESLint
`no-restricted-imports` rule (`childProcessSpawnBan` in `eslint.config.ts`, scoped by
`importNames` to the spawn/exec family) fences every other file under `src/integration/**` from
importing `node:child_process`'s spawn functions directly, so the two-exception list above is
enforced at lint time, not by convention.

**`AbortError` is the one error chains propagate transparently.** User-initiated cancellation (Ctrl+C, the
TUI abort hotkey) flows through every wrapper without being absorbed by guards or fallbacks. Anywhere a guard
or fallback catches errors, it MUST exempt `AbortError`. The chain's `AbortSignal` is now threaded all the
way into `implementSession()` via `execute(input, signal)` on every headless AI leaf (generator, evaluator,
review, create-pr, readiness, detect-scripts, detect-skills) — the signal reaches the headless provider's
SIGTERM→SIGKILL kill ladder, abort-aware exit classification, and cancellable rate-limit sleep. Without this
threading a cancel would let the spawned child run to natural completion, stranding the repo lock and leaving
the progress spinner stuck.

**AI sessions plug onto the repo (implement / ideate).** Cwd is the user's repo (multi-repo flows
pick `repositories[0]`); the per-flow sandbox under `<sprintDir>/<flow>/<unit-slug>/` is mounted via
`--add-dir` so `prompt.md` and `signals.json` round-trip through harness-controlled
paths — except on OpenCode, which has no `--add-dir` equivalent and instead auto-approves
external-directory access with `--auto` (see the OpenCode caveat above). Cwd is the repo because
Claude / Copilot / Codex only auto-discover their context file
(`CLAUDE.md` / `.github/copilot-instructions.md` / `AGENTS.md`), skills (`.claude/skills/` /
`.github/skills/` / `.agents/skills/`), agents, and `.mcp.json` from cwd — not from `--add-dir` roots.
Harness-authored skills land in `<repo>/<parentDir>/skills/ralphctl-*/` and the skills adapter appends one
wildcard line to `.git/info/exclude` on first install so they never appear in `git status` or `git add -A`.

**Refine and plan are the exceptions — their AI sessions run in the per-sprint unit root.**
Refine's session is rooted at `<sprintDir>/refinement/<ticket-slug>/`; plan's at
`<sprintDir>/plan/<run-slug>/`. Rooting either in any one repo would auto-load that repo's `CLAUDE.md` /
agents / `.mcp.json` and bias the AI toward implementation specifics (refine) or toward repositories[0]
on a multi-repo project (plan); refine would also pollute the repo with bundled skills. Plan mounts
**every** project repository as an equal `--add-dir` source — no repo enjoys cwd privilege, so the planner
treats every repo symmetrically. No AI session is rooted in any repo for either flow.

**Refine writes back as an issue comment, never an overwrite.** Refine never rewrites the issue
description and never opens a new issue — it posts the refined requirements as a NEW comment on the
ticket's linked issue via the comment-only `IssuePusher` (`comment(url, { body })`; `gh issue comment`
/ `glab issue comment`). It is opt-in: the interactive reviewer's "Post as comment" choice (offered
only when the ticket has a linked issue), or `settings.scm.postRefinementComment` (default `false`) in
non-interactive runs. The earlier "approve & update" / "approve & create" reviewer options and the
`defaultIssueOrigin`-driven create path were removed — `Project.defaultIssueOrigin` survives as a
persisted field but refine no longer consults it.

**Bundled skills (13 total) always lose to project skills.** When `<cwd>/.claude/skills/<name>/` already
exists, the bundled copy is skipped and the project copy is left untouched. The skills adapter
(`src/integration/ai/skills/adapter-factory.ts`) tracks only what it installed; uninstall removes only
those entries. Every bundled `SKILL.md` is validated by `skill-contract-checker.ts` against six harness
rules (signal contract, git ownership, one-PR, package-manager agnosticism, subagent control, verify gate);
the contract test hard-fails on any violation, keeping bundled skills safe to auto-install.

**Operator drop-in skills.** Global, provider-specific skills under `~/.ralphctl/skills/{claude,copilot,codex,opencode}/<name>/SKILL.md`
are discovered by `createOperatorSkillSource` and installed through the same `ralphctl-` namespace and
`.git/info/exclude` wildcard as bundled skills. `StoragePaths.operatorSkillsRoot` = `<appRoot>/skills`.
The compat checker runs as a warning for operator skills — a violation logs and skips, never aborts the
flow. There is no per-project operator location.

**Phase-folder opt-in skills.** Global, per-FLOW (not per-provider) opt-in skills under
`<appRoot>/skills/<flow>/<name>/SKILL.md` — the provider-agnostic sibling of the operator drop-in above.
Discovered by `createPhaseSkillSource` and installed through the same `ralphctl-` namespace and
`.git/info/exclude` wildcard as bundled/operator skills. The TUI's Skills-catalog view (`K` from Home) is
the intended writer: enabling a bundled skill copies its raw `SKILL.md` bytes into the flow's phase dir
and drops a `.provenance.json` sidecar next to it (sha256 of the copied bytes, `ralphctlVersion`,
`copiedAt`) so a later `list()` can tell in-sync / update-available / locally-modified apart; disabling
removes the folder. The sidecar is catalog-only bookkeeping — no `SkillSource` (bundled, project,
operator, or phase) ever reads it or installs it into an AI session; only `SKILL.md` reaches the model.
A hand-dropped folder with no sidecar is a valid `manual` entry and loads exactly like a catalog-managed
one. Selection is resolved once, at launch, by `createResolvedSkillSource`: a phase-folder copy shadows
a same-named bundled default, and either can be subtracted per-flow via `settings.ai.skills[flow].disabled`
or the customize picker's per-run override (see `AI-SETTINGS.md`).

**`pnpm skills:update` (maintainers only).** Re-vendors upstream `SKILL.md` files from URLs in
`scripts/skills-sources.json` into `scripts/vendor/skills/` for human review; adapted committed copies live
under `src/integration/ai/skills/bundled/<name>/SKILL.md`. Bundled skills are frozen committed source —
no runtime download, no runtime provenance check.

**File-based AI provider contract** — providers write `signals.json` and a `session-id.txt` file per spawn
(both persisted to `<sprintDir>/implement/<unit-slug>/rounds/<N>/<role>/`); the harness reads them
post-spawn. No stdout parsing for signals or session IDs. Replaces a long-standing brittleness vector
when CLI vendors tweak JSON shape.
