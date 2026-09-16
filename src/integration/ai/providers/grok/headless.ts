import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import { isGrokModel } from '@src/domain/value/settings-models/grok.ts';
import { writeTextAtomic } from '@src/integration/io/fs.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { HeadlessProviderDeps } from '@src/integration/ai/providers/_engine/headless-provider-deps.ts';
import type { SessionPermissions } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import { validateModel } from '@src/integration/ai/providers/_engine/validate-model.ts';
import { type ProviderSpawn, defaultProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';
import { DEFAULT_RATE_LIMIT_RE } from '@src/integration/ai/providers/_engine/classify-spawn-exit.ts';
import type { AttemptOutcome } from '@src/integration/ai/providers/_engine/attempt-outcome.ts';
import {
  createHeadlessProvider,
  emitTokenUsage,
  runProviderAttempt,
} from '@src/integration/ai/providers/_engine/run-provider-attempt.ts';
import { createGrokAttemptTracker } from '@src/integration/ai/providers/grok/parse-stream.ts';

/**
 * {@link HeadlessAiProvider} backed by the Grok Build CLI (`grok`).
 *
 * Flag surface and permission semantics verified against Grok Build CLI 1.0.30's shipped CLI
 * reference on 2026-09-15; minimum supported version is 1.0.13 (the interactive adapter's `-s`).
 *
 * Translation table (intent → Grok argv):
 *
 *   | AiSession field               | Grok argv                                                  |
 *   | ----------------------------- | ---------------------------------------------------------- |
 *   | (always)                      | `--no-auto-update --trust --output-format streaming-json`  |
 *   | cwd                           | `--cwd <cwd>`                                              |
 *   | model                         | `-m <model>`                                               |
 *   | resume: <SessionId>           | `-r <id>`                                                  |
 *   | effort: <level>               | `--effort <level>`                                         |
 *   | permissions FULL_AUTO         | `--always-approve --sandbox off`                           |
 *   | permissions (any gate closed) | `--always-approve --sandbox off … --no-subagents`          |
 *   |   !canModifyRepoFiles         | `--deny 'Edit(./**)'`                                      |
 *   |   !canRunShell                | `--disallowed-tools run_terminal_command,run_terminal_cmd` |
 *   |                               | plus `--deny 'Bash(*)'` — see the shell note below         |
 *   |   !canAccessNetwork           | `--disallowed-tools web_search,web_fetch`                  |
 *   | prompt                        | `--prompt-file <grok-prompt.md>`                           |
 *
 * `--prompt-file` triggers headless. So does `-p` / `--single` — it is the vendor's primary
 * headless switch — but it inlines the prompt body into argv and a rendered harness prompt blows
 * the 32,767-byte Windows command line, so the file form is used unconditionally. Grok does not
 * read piped stdin as the prompt. If the prompt file cannot be written, the spawn fails rather
 * than hanging in the TUI.
 *
 * ## Permission gates — why the edit gate is a rule, not a tool removal
 *
 * Grok has NO `write` tool. Its file tools are `read_file` / `search_replace` / `list_dir`, and
 * `Edit`, `Write` and `MultiEdit` are all aliases OF `search_replace`, which CREATES a file when
 * `old_string` is empty (10-hooks.md alias table, 01-getting-started.md and 18-sandbox.md tool
 * lists). `--disallowed-tools` REMOVES a built-in tool and is headless-only, so denying
 * `search_replace` for a read-only flow strips the only tool that can create a file — every
 * headless READ_ONLY flow (readiness, detect-scripts, detect-skills, the best-of-n judge) would
 * end with no `signals.json` and read as an empty run.
 *
 * The edit gate is therefore a permission RULE: `--deny 'Edit(./**)'`. Tool paths are lexically
 * normalized (`.`/`..` collapsed) and relative ones are joined with the session working directory
 * — here `--cwd`, the repo or the per-task worktree — so a rooted pattern like `Edit(./**)` scopes
 * to it and traversal cannot escape, while `grok-prompt.md` / `signals.json` in the session
 * directory OUTSIDE cwd stay creatable through `search_replace`. Deny wins over allow and over
 * `--always-approve`, works in headless and interactive, and `Edit` deny rules also cover paths a
 * shell command touches (22-permissions-and-safety.md, Read/Edit/Grep Rules). Shell keeps the
 * dual-spelled tool removal (`run_terminal_command` is the live id, `run_terminal_cmd` the docs'
 * id) AND adds `--deny 'Bash(*)'` — `*` globs the whole command — so a renamed tool id cannot
 * silently escape its gate. Network stays a tool removal (`web_search` / `web_fetch`).
 * `--no-subagents` keeps a child agent from recovering a denied class under `--always-approve`.
 * Never `--permission-mode plan` (blocks signals.json). `--sandbox off` is forced so an operator's
 * `~/.grok/config.toml` cannot re-enable workspace/strict and block `grok-prompt.md` /
 * `signals.json` outside cwd.
 *
 * The deny-rule gate is verified against the 1.0.30 CLI reference, NOT against a live model call
 * in this release. Its failure direction is an over-grant — an edit the rule should have caught
 * gets through — never a blocked `signals.json`, because the envelope is written by a tool that
 * stays present and lives outside the denied path. The next section is what makes "outside the
 * denied path" true rather than merely usual.
 *
 * ## The topology the edit rule depends on, and what happens when it does not hold
 *
 * "Never a blocked `signals.json`" rests on the session directory sitting OUTSIDE `--cwd`, which
 * is only the DEFAULT topology: `resolveStoragePaths` honours `RALPHCTL_HOME` verbatim, so
 * `RALPHCTL_HOME=<repo>/.ralphctl` puts the envelope under the denied tree and a cwd-rooted
 * `Edit(./**)` would deny its creation — every headless READ_ONLY flow failing exactly the way
 * removing `search_replace` would have. {@link envelopeInsideCwd} makes the invariant structural
 * instead of assumed: when the session directory resolves at or under `cwd`, the edit deny rule is
 * SKIPPED and the spawn logs a warning naming the over-grant. A read-only flow that runs
 * edit-capable is the documented failure direction; a read-only flow with no contract envelope is
 * not. The shell and network gates are topology-independent and stay closed either way, as does
 * `--no-subagents`.
 *
 * ## `--trust` — persisted folder trust, and what it actually grants
 *
 * Grok's folder trust is UNIFIED: one `--trust` grant trusts the folder for project instructions
 * (`AGENTS.md`), project skills (`.grok/skills`), project permission rules (`.grok/config.toml`,
 * `.claude/settings.json`), project hooks (`.grok/hooks/*.json`, `.claude/settings.json`,
 * `.cursor/hooks.json`) and repo-local MCP / LSP servers, together — a headless start in an
 * untrusted folder silently skips all of them (10-hooks.md, 22-permissions-and-safety.md).
 * ralphctl writes the `AGENTS.md` and `.grok/skills` half itself and cannot load them without the
 * grant, so it passes `--trust` unconditionally and accepts the rest of the blast radius: a
 * ralphctl run therefore executes the checkout's own hooks and repo-local MCP servers. The posture
 * is explicit — ralphctl runs a checkout the way you would by opening it in Grok yourself, so run
 * it only against repos you would trust there. Grok PERSISTS the decision in its trust store, for
 * the repo and for every per-task worktree path, since a nested checkout is a separate workspace
 * needing its own grant (10-hooks.md).
 *
 * ## additionalRoots — named over-grant
 *
 * Grok has no `--add-dir`. With `--sandbox off`, writes outside cwd work, so extra roots are
 * treated as a documented over-grant (same posture as OpenCode `--auto`) rather than an
 * InvalidStateError. The edit deny rule is cwd-rooted, so an additional root stays writable even
 * in a read-only flow — that is the named over-grant, not an oversight.
 *
 * Docs: https://docs.x.ai/build/overview
 */

const PROVIDER_NAME = 'grok-provider';
const GROK_PROMPT_FILENAME = 'grok-prompt.md';

/**
 * Stale-resume detection. A `-r <id>` naming a session the CLI no longer has locally fails with
 * "Session "…" not found locally, restoring conversation from remote..." then
 * "Failed to restore session from remote: fetching session record: session get failed: 404".
 */
const RESUME_STALE_RE = /session(?: .+)? not found|failed to restore session|session get failed: 404/i;

const TOOL_SHELL = ['run_terminal_command', 'run_terminal_cmd'] as const;
const TOOL_NETWORK = ['web_search', 'web_fetch'] as const;

/** Edits scoped to the session working directory (`--cwd`); the session dir outside it stays writable. */
const DENY_EDIT_CWD = 'Edit(./**)';
/** `*` globs the whole command, so this matches every shell invocation. */
const DENY_BASH_ALL = 'Bash(*)';

/**
 * Translate {@link SessionPermissions} into Grok's `--disallowed-tools` denylist.
 * Returns empty when neither the shell nor the network gate is closed — caller skips the flag.
 * `search_replace` is never listed: it is the only tool that can create `signals.json`, so the
 * edit gate is a deny RULE instead (see the file header).
 */
const disallowedToolsFor = (p: SessionPermissions): readonly string[] => {
  const denied: string[] = [];
  if (!p.canRunShell) denied.push(...TOOL_SHELL);
  if (!p.canAccessNetwork) denied.push(...TOOL_NETWORK);
  return denied;
};

/**
 * Does the session directory — where `grok-prompt.md` and `signals.json` land — resolve at or
 * under `--cwd`?
 *
 * {@link DENY_EDIT_CWD} only works because the envelope normally sits OUTSIDE cwd, and nothing
 * enforces that: `resolveStoragePaths` honours `RALPHCTL_HOME` verbatim, so a home pointed inside
 * the repo puts `signals.json` under the denied tree. This is the structural check that keeps the
 * rule from ever blocking the one write the file-based contract requires — see the header section
 * on the topology invariant.
 */
const envelopeInsideCwd = (session: AiSession): boolean => {
  const rel = relative(String(session.cwd), dirname(String(session.signalsFile)));
  if (rel === '') return true;
  // A different Windows volume yields an absolute path; `..` (alone or as the first segment) means
  // the session directory climbs out of cwd. Both are outside.
  if (isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${sep}`);
};

/**
 * Translate {@link SessionPermissions} into repeatable `--deny <rule>` flags. Deny wins over
 * `--always-approve`, so these are the hard gates; the shell rule backs the tool removal above
 * against a renamed tool id.
 *
 * `canDenyCwdEdits` is false when {@link envelopeInsideCwd} holds — the cwd-rooted edit rule would
 * then deny `signals.json` itself, so it is dropped and the over-grant is logged at the spawn site.
 */
const denyRulesFor = (p: SessionPermissions, canDenyCwdEdits: boolean): readonly string[] => {
  const rules: string[] = [];
  if (!p.canModifyRepoFiles && canDenyCwdEdits) rules.push(DENY_EDIT_CWD);
  if (!p.canRunShell) rules.push(DENY_BASH_ALL);
  return rules;
};

/** Any closed gate pulls `--no-subagents` — a child agent must not recover a denied class. */
const anyGateClosed = (p: SessionPermissions): boolean =>
  !p.canModifyRepoFiles || !p.canRunShell || !p.canAccessNetwork;

/** Model gate shared by {@link buildGrokArgs} and the dry run that precedes the prompt write. */
const validateGrokModel = (model: string): Result<void, InvalidStateError> =>
  validateModel(model, isGrokModel, {
    entity: PROVIDER_NAME,
    attemptedAction: 'build argv',
    notKnownMessage: `grok-provider: '${model}' is not a known Grok model`,
  });

const materializeGrokPrompt = async (session: AiSession): Promise<Result<string, StorageError>> => {
  const path = join(dirname(String(session.signalsFile)), GROK_PROMPT_FILENAME);
  const wrote = await writeTextAtomic(path, session.prompt);
  if (!wrote.ok) return Result.error(wrote.error);
  return Result.ok(path);
};

export const buildGrokArgs = (session: AiSession, promptFile: string): Result<readonly string[], InvalidStateError> => {
  const validated = validateGrokModel(session.model);
  if (!validated.ok) return Result.error(validated.error);

  const args: string[] = [
    '--no-auto-update',
    // Without it, AGENTS.md and the `.grok/skills` ralphctl just wrote are skipped at startup.
    '--trust',
    '--output-format',
    'streaming-json',
    '--prompt-file',
    promptFile,
    '--cwd',
    String(session.cwd),
    '-m',
    session.model,
  ];
  if (session.effort !== undefined) {
    args.push('--effort', session.effort);
  }
  if (session.resume !== undefined) {
    args.push('-r', String(session.resume));
  }
  // CLI flags beat ~/.grok/config.toml. Forcing `off` is the Grok equivalent of OpenCode
  // `--auto`: without it a workspace/strict sandbox blocks grok-prompt.md and signals.json
  // (both live outside --cwd).
  args.push('--sandbox', 'off');
  args.push('--always-approve');
  const denied = disallowedToolsFor(session.permissions);
  if (denied.length > 0) args.push('--disallowed-tools', denied.join(','));
  for (const rule of denyRulesFor(session.permissions, !envelopeInsideCwd(session))) args.push('--deny', rule);
  if (anyGateClosed(session.permissions)) args.push('--no-subagents');
  return Result.ok(args);
};

interface RunGrokAttemptOpts {
  readonly spawnFn: ProviderSpawn;
  readonly command: string;
  readonly deps: HeadlessProviderDeps;
}

/**
 * Name the over-grant {@link buildGrokArgs} just made: a read-only session whose envelope lives
 * inside `--cwd` ships without the edit deny rule, because the rule would block `signals.json`.
 * Logged rather than failed — the alternative is a flow that reports an empty run.
 */
const warnSkippedEditDeny = (deps: HeadlessProviderDeps, session: AiSession): void => {
  if (session.permissions.canModifyRepoFiles || !envelopeInsideCwd(session)) return;
  deps.eventBus.publish({
    type: 'log',
    level: 'warn',
    message: `${PROVIDER_NAME}: session directory is inside --cwd, so the read-only edit rule ${DENY_EDIT_CWD} was skipped — it would have denied signals.json. This session can edit the repo; point RALPHCTL_HOME outside it to restore the gate`,
    meta: { cwd: String(session.cwd), sessionDir: dirname(String(session.signalsFile)) },
    at: IsoTimestamp.now(),
  });
};

const runGrokAttempt = async (
  attemptSession: AiSession,
  { spawnFn, command, deps }: RunGrokAttemptOpts
): Promise<AttemptOutcome> => {
  // Validate before writing: an unknown / suspended model fails argv construction, and paying for
  // an mkdir + atomic write for a spawn that never happens would leave a stray artifact (mirrors
  // `copilot/headless.ts`, the other pointer-delivery adapter).
  const validated = validateGrokModel(attemptSession.model);
  if (!validated.ok) return { kind: 'error', error: validated.error };

  const promptFile = await materializeGrokPrompt(attemptSession);
  if (!promptFile.ok) return { kind: 'error', error: promptFile.error };
  const built = buildGrokArgs(attemptSession, promptFile.value);
  if (!built.ok) return { kind: 'error', error: built.error };
  warnSkippedEditDeny(deps, attemptSession);

  const tracker = createGrokAttemptTracker(deps.eventBus);

  return runProviderAttempt({
    spawnFn,
    command,
    args: built.value,
    session: attemptSession,
    // `end` is last and is the only record that carries `sessionId`. Node can fire `exit`
    // before that chunk is delivered; `close` waits for the stdout pipe to drain.
    resolveOn: 'close',
    rateLimitRe: DEFAULT_RATE_LIMIT_RE,
    onStdoutChunk: (chunk) => tracker.consumeChunk(chunk),
    flush: () => tracker.flush(),
    getSessionId: () => tracker.getSessionId(),
    getStdoutTail: () => tracker.getStdoutTail(),
    getProcessErrorText: () => tracker.getStreamError(),
    getBody: () => Promise.resolve(Result.ok(tracker.getBody())),
    emitProviderTokenUsage: (sessionId_) => {
      const inputTokens = tracker.getInputTokens();
      const outputTokens = tracker.getOutputTokens();
      const cacheReadTokens = tracker.getCacheReadTokens();
      const cacheCreationTokens = tracker.getCacheCreationTokens();
      return emitTokenUsage(deps.eventBus, attemptSession, sessionId_, {
        provider: 'xai-grok',
        model: attemptSession.model,
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
        ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
      });
    },
    providerName: PROVIDER_NAME,
    providerSlug: 'grok',
    eventBus: deps.eventBus,
    ...(deps.idleMs !== undefined ? { idleMs: deps.idleMs } : {}),
  });
};

export const createGrokProvider = (deps: HeadlessProviderDeps): HeadlessAiProvider => {
  const spawnFn: ProviderSpawn = deps.spawn ?? defaultProviderSpawn;
  const command = deps.command ?? 'grok';

  return createHeadlessProvider({
    providerSlug: 'grok',
    providerName: PROVIDER_NAME,
    resumeStaleRe: RESUME_STALE_RE,
    rateLimitRetries: deps.rateLimitRetries,
    eventBus: deps.eventBus,
    ...(deps.backoffSchedule !== undefined ? { backoffSchedule: deps.backoffSchedule } : {}),
    createGenerateContext: () => ({
      attempt: (attemptSession) => runGrokAttempt(attemptSession, { spawnFn, command, deps }),
    }),
  });
};
