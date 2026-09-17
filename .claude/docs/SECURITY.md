# Security & Safety

> On-demand reference (split out of `CLAUDE.md`). Read when touching the permission model, the
> cross-process lock, process spawning, skills, refine write-back, or the file-based provider contract.

**Permission model — two orthogonal axes.** `SessionPermissions` gates **capabilities**
(`canModifyRepoFiles`, `canRunShell`, `canAccessNetwork`, `autoApprove`); `cwd` +
`additionalRoots` + `outputDir` on the `AiSession` define **topology** (which paths the AI
can read / write). Topology is the primary defense; capabilities are the secondary filter.

The ability to **create a file is never denied** under any profile — the file-based signals contract
requires the AI to land `signals.json` in `outputDir`. On four backends that means the `Write` tool
stays allowed; Grok has no `write` tool at all (see the Grok caveat below), so there the edit gate is
a path-scoped deny rule instead. To deny writes to a tree, don't mount it.
`outputDir` is auto-included as a writable root in every provider (see
`providers/_engine/resolve-roots.ts`).

| Provider         | Always passes                                             | Read-only profile maps to                                                                                                                                                     | Native context file               |
| ---------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `claude-code`    | `--permission-mode bypassPermissions`                     | `--disallowedTools Edit,MultiEdit,NotebookEdit,Bash`                                                                                                                          | `CLAUDE.md` at repo root          |
| `github-copilot` | `--no-ask-user --autopilot --silent`                      | `--allow-all-tools --deny-tool=shell`                                                                                                                                         | `.github/copilot-instructions.md` |
| `openai-codex`   | `-s workspace-write` (no `-a` flag)                       | `-s workspace-write` (topology-scoped)                                                                                                                                        | `AGENTS.md`                       |
| `opencode`       | `run --format json --dir <cwd> -m <provider/model>`       | **nothing — no argv spelling exists**                                                                                                                                         | `AGENTS.md`                       |
| `xai-grok`       | `--no-auto-update --trust --always-approve --sandbox off` | `--deny 'Edit(./**)' --deny 'Bash(*)' --disallowed-tools run_terminal_command,run_terminal_cmd --no-subagents` (plus `web_search,web_fetch` when `canAccessNetwork` is false) | `AGENTS.md`                       |

Codex caveat: `codex exec` has only two sandbox modes (`read-only` / `workspace-write`), and
`read-only` blocks every write (incl. signals.json). Every profile maps to `workspace-write`;
Codex can't fine-grained-deny edits on existing repo files. Use topology to constrain it.

OpenCode caveat (stronger): `opencode run` (headless — implement generator/evaluator, review,
create-pr, readiness, detect-scripts, detect-skills) exposes exactly ONE approval control, `--auto`,
and omitting it does NOT make the session read-only — a plain `run` still executes write and edit
tools without prompting (verified against v1.18.15). There is therefore no argv spelling of
`canModifyRepoFiles: false` at all; path
topology is the only boundary. Plainly stated: OpenCode has no flag to grant write access to just
one extra directory — permission is all-or-nothing (`--dir` sets a single root, and its
`external_directory` permission auto-REJECTS access outside that root). ralphctl's `outputDir`
(where `signals.json` lands) routinely sits outside the project folder, so whenever `outputDir` /
`additionalRoots` fall outside `cwd` the headless adapter emits `--auto` to clear that gate
wholesale — without it the AI would sit blocked waiting for an external-directory approval that
never arrives. In practice `--auto` is therefore passed on effectively every headless run, and the
project/session directory is the real safety boundary, not the CLI's permission gate — exactly as
already documented above for OpenAI Codex. One clarification worth keeping in mind when reading
that flag: `--auto` promotes the tool classes an operator set to `ask`, but per OpenCode's
permissions documentation it does not override a class set to `deny` — an explicit denial in the
operator's `opencode.json` stays enforced.

The interactive adapter (TUI handoff — ideate, plan, refine) has no `--auto` flag at all on
its default command, so it uses OpenCode's config-level `permission.external_directory` map
instead, injected per-session as an `OPENCODE_CONFIG_CONTENT` overlay that MERGES into the
operator's own config (so their models / agents / instructions survive; only a conflicting
`external_directory` rule is overridden). `buildOpencodeEnv` (`providers/opencode/interactive.ts`)
grants EVERY root the engine folded for that session — `cwd`, the caller's `additionalRoots`, and
the prompt / output directories — as `allow` keys, `*` staying `deny` as the floor; each root gets
four keys (both separator spellings × `{*, **}`), since the rules are globs. A root that contains a
glob metacharacter (`* ? [ ] { }`) cannot be written as a pattern matching exactly that directory,
so `buildOpencodeEnv` returns `InvalidStateError` instead of silently granting less — nothing is
spawned and nothing claims a session started. This replaced an earlier, narrower grant that covered
only the prompt file's directory: a caller's `additionalRoots` (every multi-repo `plan` / `refine`
session) were mounted nowhere and OpenCode refused them with no error surfaced (#278).

Grok caveat: the Grok Build CLI (`grok`) has no `--add-dir`. The adapter forces `--sandbox off` so
an operator's `~/.grok/config.toml` cannot re-enable workspace/strict and block `grok-prompt.md` /
`signals.json` outside cwd. Extra roots are a named over-grant (same posture as OpenCode `--auto`)
rather than an `InvalidStateError` — and because the read-only edit rule is cwd-rooted, an extra
root stays writable in a read-only flow too. Full-auto and read-only both pass `--always-approve`.

Grok has **no `write` tool**: its file tools are `read_file` / `search_replace` / `list_dir`, and
`Edit`, `Write` and `MultiEdit` are aliases of `search_replace`, which creates a file when the old
string is empty. `--disallowed-tools` REMOVES a tool, so denying `search_replace` in a read-only
session would strip the only tool that can create `signals.json` and leave every headless read-only
flow (readiness, detect-scripts, detect-skills, the best-of-n judge) with no contract envelope. The
gates are therefore split by mechanism:

- `!canModifyRepoFiles` → `--deny 'Edit(./**)'`. Tool paths are lexically normalized (`.`/`..`
  collapsed) and relative ones joined with the session working directory (`--cwd`), so a rooted
  pattern like `Edit(./**)` scopes to it and cannot be escaped by traversal, while the session
  directory outside cwd stays writable.
- `!canRunShell` → `--disallowed-tools run_terminal_command,run_terminal_cmd` AND `--deny 'Bash(*)'`.
- `!canAccessNetwork` → `--disallowed-tools web_search,web_fetch`.
- any closed gate → `--no-subagents`, so a child cannot recover a denied class.

Never `--permission-mode plan` (blocks signals.json). Deny rules win over allow rules and over
`--always-approve`, and an `Edit` deny also applies to paths a shell command touches — but they are
the CLI's own permission layer, not an OS sandbox, and the tool-removal half is still deny-by-name
against a CLI that has renamed a tool once (`run_terminal_command` live vs `run_terminal_cmd` in the
docs); the `Bash(*)` rule is what stands behind that rename. The mapping is verified against Grok
Build CLI 1.0.30's shipped CLI reference (2026-09-15), not against a live model call; its failure
direction is an over-grant, never a blocked `signals.json` — see the topology paragraph below for
what enforces that. **Maintenance contract:** on every grok
version bump, re-verify the tool ids AND the rule spellings in `disallowedToolsFor` / `denyRulesFor`
(`providers/grok/headless.ts`) against the shipped CLI reference before trusting the read-only
profile.

"Never a blocked `signals.json`" holds only while the session directory sits OUTSIDE `--cwd`, which
is the default topology but not an enforced one: `resolveStoragePaths` honours `RALPHCTL_HOME`
verbatim, so `RALPHCTL_HOME=<repo>/.ralphctl` would put the envelope under the denied tree. The
adapter makes the invariant structural rather than assumed — `buildGrokArgs` resolves
`dirname(signalsFile)` against `cwd` and, when it lands at or under it, SKIPS `--deny 'Edit(./**)'`
and publishes a `warn` naming the over-grant. A read-only flow that runs edit-capable is the
documented failure direction; a read-only flow with no contract envelope is not. The shell and
network gates are topology-independent and close either way, as does `--no-subagents`.

Both Grok surfaces also pass `--trust`, and Grok's folder trust is **unified**: one grant trusts the
folder for project instructions (`AGENTS.md`), project skills (`.grok/skills`), project permission
rules (`.grok/config.toml`, `.claude/settings.json`), project hooks (`.grok/hooks/*.json`,
`.claude/settings.json`, `.cursor/hooks.json`) and repo-local MCP / LSP servers **together**
(10-hooks.md, 22-permissions-and-safety.md); project hooks specifically require it "to prevent
supply-chain attacks from malicious repos". ralphctl writes the `AGENTS.md` / `.grok/skills` half
itself and an untrusted folder skips it silently, so the grant is passed unconditionally and the
rest of the blast radius is accepted: a ralphctl run executes the checkout's own hooks and
repo-local MCP / LSP servers, on both surfaces, in the repo and in every per-task worktree. The
posture is explicit — **ralphctl runs a checkout the way you would by opening it in Grok yourself;
run it only against repos you would trust there.** Grok persists the decision in its trust store,
per folder, so each repo and each per-task worktree path ralphctl runs in is left trusted afterwards
(a nested checkout is a separate workspace and needs its own grant).

The `readiness` flow fans out across every uniquely referenced provider in `settings.ai` — one native
context file per provider (claude-code → `CLAUDE.md`, github-copilot → `.github/copilot-instructions.md`,
openai-codex → `AGENTS.md`, opencode → `AGENTS.md`, xai-grok → `AGENTS.md`). Single-provider
configurations produce exactly one file; mixed configurations produce one file per distinct native
context file — `openai-codex`, `opencode`, and `xai-grok` share the repo-root `AGENTS.md`, so a config
naming more than one of those three runs sequential readiness passes over that same file (each later
write overwrites it, preserving the previous pass's output verbatim in a `<path>.bak.<timestamp>`
copy). No symlinks, no pointer schemes. Don't introduce either.

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

**A prompt body never travels in argv.** Every adapter writes the rendered prompt to a file and passes the
CLI a POINTER at that file (`providers/_engine/prompt-pointer.ts`) — headless claude / codex / opencode pipe
it through stdin instead, which is equivalent for this purpose; headless grok uses `--prompt-file`
`grok-prompt.md` (like copilot's file pointer, not stdin — Grok does not read piped stdin as the prompt)
and never `--prompt-file` on the interactive command (that forces headless). Argv is capped at 32,767 bytes on Windows
(and 8,191 once a `.cmd` shim routes through `cmd.exe`, where the excess is silently TRUNCATED rather than
reported), well under what a rendered harness prompt reaches — a plan session on Windows died with
`spawn ENAMETOOLONG` before the CLI started. Each interactive adapter grants its CLI read access to every
mounted root — `--add-dir` for claude / copilot / codex, and for OpenCode (which has no such flag) an
`external_directory` grant per root injected as `OPENCODE_CONFIG_CONTENT` (see `buildOpencodeEnv`), which
MERGES into the operator's own config rather than replacing it. Grok has no `--add-dir` either; extra
roots are the named over-grant above (sandbox off). There is no inline-body fallback: a CLI that can be granted
no access at all does not belong on this port, since inlining the body for it would just relocate the same
overflow. Reject such an adapter where it is declared. Two
earlier answers to this are on the rejected list and must not return: a `bash -lc "… $(cat promptFile)"`
wrapper (cannot execute `.cmd` shims, mangles Windows backslash paths, silently dropped the Copilot seed)
and `shell: true` for binary+args (mis-quotes spaces and `& | % "`). `providers/_engine/argv-budget.ts`
carries the limits and turns an overflow into a named, non-retryable error instead of a bare errno.

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
paths — except on OpenCode, which has no `--add-dir` equivalent and instead grants the same roots
via `--auto` (implement, headless) or the `buildOpencodeEnv` config grant (ideate, interactive) —
see the OpenCode caveats above — and on Grok, which also has no `--add-dir` and treats extra roots
as a named over-grant (sandbox off). Cwd is the repo because
Claude / Copilot / Codex / OpenCode / Grok only auto-discover their context file
(`CLAUDE.md` / `.github/copilot-instructions.md` / `AGENTS.md`), skills (`.claude/skills/` /
`.github/skills/` / `.agents/skills/` / `.opencode/skills/` / `.grok/skills/`), agents, and `.mcp.json` from cwd — not from `--add-dir` roots.
Harness-authored skills land in `<repo>/<parentDir>/skills/ralphctl-*/` and the skills adapter appends one
wildcard line to `.git/info/exclude` on first install so they never appear in `git status` or `git add -A`.
The line goes to the **common** git dir (`$GIT_COMMON_DIR`, resolved through the worktree gitdir's `commondir`
file) — `info/` is a shared path in git, so a per-worktree copy would be silently ignored and the parallel
implement path would commit harness-authored skills into the user's branch.

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

**Bundled skills (13 total) always lose to project skills — unless the folder is a leftover of ralphctl's
own.** When `<cwd>/.claude/skills/<name>/` already exists, the bundled copy is skipped and the project
copy is left untouched, UNLESS that folder itself carries a `.ralphctl-install.json` ownership marker
(`skill-install-marker.ts`) naming a process that is no longer running — a leftover from a run that was
killed or crashed between install and uninstall — in which case it's deleted and rewritten with the
current skill instead of shadowing it forever, logged at info naming the folder, the skill, and the dead
pid the marker blamed (or, when the marker's JSON can't be parsed, the replacement without a pid); a
marker naming a still-live process is left alone. No content comparison against the rendered skill is
made before replacing — version drift between the leftover and the current bundle is normal and not
itself a signal. The skills adapter (`src/integration/ai/skills/adapter-factory.ts`) tracks only what it
installed; uninstall removes only those entries. Every bundled `SKILL.md` is validated by
`skill-contract-checker.ts` against seven harness
rules (signal contract, git ownership, one-PR, package-manager agnosticism, subagent control, verify gate,
angle-bracket signal-tag syntax); the contract test hard-fails on any violation, keeping bundled skills
safe to auto-install. The seventh (S7) is a syntax rule, not an imperative-command one: the shipped output
contract is a typed `signals.json` object, so a skill telling the AI to emit `<task-complete>` or `<note>`
teaches a contract the harness never parses. It therefore runs on every line rather than only instruction
lines, and its pattern is bounded on both sides so a generic type (`Array<Change>`) is not read as a tag.

**Operator drop-in skills.** Global, provider-specific skills under `~/.ralphctl/skills/{claude,copilot,codex,opencode,grok}/<name>/SKILL.md`
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
