import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { isGrokModel } from '@src/domain/value/settings-models/grok.ts';
import { writeTextAtomic } from '@src/integration/io/fs.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { HeadlessProviderDeps } from '@src/integration/ai/providers/_engine/headless-provider-deps.ts';
import type { SessionPermissions } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import { validateModel } from '@src/integration/ai/providers/_engine/validate-model.ts';
import { DEFAULT_RATE_LIMIT_RE } from '@src/integration/ai/providers/_engine/classify-spawn-exit.ts';
import type { AttemptOutcome } from '@src/integration/ai/providers/_engine/attempt-outcome.ts';
import {
  type AttemptBase,
  createHeadlessProvider,
  runProviderAttempt,
} from '@src/integration/ai/providers/_engine/run-provider-attempt.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
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
 *   |                               | plus `--deny 'Bash(*)'`                                    |
 *   |   !canAccessNetwork           | `--disallowed-tools web_search,web_fetch`                  |
 *   | prompt                        | `--prompt-file <grok-prompt.md>`                           |
 *   | role: evaluator               | env `GROK_MEMORY=0`                                        |
 *
 * `--prompt-file` (not `-p`, which inlines the body into argv) is the headless switch; Grok does
 * not read piped stdin. Why the edit gate is a cwd-rooted deny RULE rather than a tool removal, the
 * session-dir topology it depends on, and what `--trust` grants: `.claude/docs/SECURITY.md`
 * (Grok caveat). Re-verify the tool ids and rule spellings there on every grok version bump.
 *
 * Docs: https://docs.x.ai/build/overview
 */

const PROVIDER_NAME = 'grok-provider';
const GROK_PROMPT_FILENAME = 'grok-prompt.md';

/**
 * "Session … not found locally, restoring conversation from remote..." is informational — the
 * remote restore may still succeed — so only the bare "not found" and the restore failure count.
 */
const RESUME_STALE_RE =
  /session(?: .+)? not found(?! locally, restoring)|failed to restore session|session get failed: 404/i;

const TOOL_SHELL = ['run_terminal_command', 'run_terminal_cmd'] as const;
const TOOL_NETWORK = ['web_search', 'web_fetch'] as const;

/** Edits scoped to the session working directory (`--cwd`); the session dir outside it stays writable. */
const DENY_EDIT_CWD = 'Edit(./**)';
/** `*` globs the whole command, so this matches every shell invocation. */
const DENY_BASH_ALL = 'Bash(*)';

/** Never lists `search_replace`: it is the only tool that can create `signals.json`. */
const disallowedToolsFor = (p: SessionPermissions): readonly string[] => {
  const denied: string[] = [];
  if (!p.canRunShell) denied.push(...TOOL_SHELL);
  if (!p.canAccessNetwork) denied.push(...TOOL_NETWORK);
  return denied;
};

/**
 * Does the session directory resolve at or under `--cwd`? Then {@link DENY_EDIT_CWD} would deny
 * `signals.json` itself — possible when `RALPHCTL_HOME` points inside the repo.
 */
const envelopeInsideCwd = (session: AiSession): boolean => {
  const rel = relative(String(session.cwd), dirname(String(session.signalsFile)));
  if (rel === '') return true;
  // A different Windows volume yields an absolute path; `..` (alone or as the first segment) means
  // the session directory climbs out of cwd. Both are outside.
  if (isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${sep}`);
};

/** Deny rules beat `--always-approve`; `Bash(*)` backs the shell tool removal against a renamed tool id. */
const denyRulesFor = (p: SessionPermissions, canDenyCwdEdits: boolean): readonly string[] => {
  const rules: string[] = [];
  if (!p.canModifyRepoFiles && canDenyCwdEdits) rules.push(DENY_EDIT_CWD);
  if (!p.canRunShell) rules.push(DENY_BASH_ALL);
  return rules;
};

/** Any closed gate pulls `--no-subagents` — a child agent must not recover a denied class. */
const anyGateClosed = (p: SessionPermissions): boolean =>
  !p.canModifyRepoFiles || !p.canRunShell || !p.canAccessNetwork;

export const buildGrokArgs = (session: AiSession, promptFile: string): Result<readonly string[], InvalidStateError> => {
  const validated = validateModel(session.model, isGrokModel, {
    entity: PROVIDER_NAME,
    attemptedAction: 'build argv',
    notKnownMessage: `grok-provider: '${session.model}' is not a known Grok model`,
  });
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
  // CLI flags beat ~/.grok/config.toml, whose workspace/strict sandbox would block the session dir outside --cwd.
  args.push('--sandbox', 'off');
  args.push('--always-approve');
  const denied = disallowedToolsFor(session.permissions);
  if (denied.length > 0) args.push('--disallowed-tools', denied.join(','));
  for (const rule of denyRulesFor(session.permissions, !envelopeInsideCwd(session))) args.push('--deny', rule);
  if (anyGateClosed(session.permissions)) args.push('--no-subagents');
  return Result.ok(args);
};

/** Names the over-grant of a read-only session that had to ship without the edit deny rule. */
const warnSkippedEditDeny = (eventBus: EventBus, session: AiSession): void => {
  if (session.permissions.canModifyRepoFiles || !envelopeInsideCwd(session)) return;
  eventBus.publish({
    type: 'log',
    level: 'warn',
    message: `${PROVIDER_NAME}: session directory is inside --cwd, so the read-only edit rule ${DENY_EDIT_CWD} was skipped — it would have denied signals.json. This session can edit the repo; point RALPHCTL_HOME outside it to restore the gate`,
    meta: { cwd: String(session.cwd), sessionDir: dirname(String(session.signalsFile)) },
    at: IsoTimestamp.now(),
  });
};

const runGrokAttempt = async (attemptSession: AiSession, base: AttemptBase): Promise<AttemptOutcome> => {
  // Next to signals.json, inside a mounted root for every caller. Argv is built (and the model
  // validated) before the write, so a spawn that never happens leaves no stray file.
  const promptFile = join(dirname(String(attemptSession.signalsFile)), GROK_PROMPT_FILENAME);
  const built = buildGrokArgs(attemptSession, promptFile);
  if (!built.ok) return { kind: 'error', error: built.error };
  const wrote = await writeTextAtomic(promptFile, attemptSession.prompt);
  if (!wrote.ok) return { kind: 'error', error: wrote.error };
  warnSkippedEditDeny(base.eventBus, attemptSession);

  const tracker = createGrokAttemptTracker(base.eventBus);

  return runProviderAttempt({
    ...base,
    args: built.value,
    session: attemptSession,
    // Opt-in cross-session memory is shared by every worktree; the evaluator side stays a fresh-context judge.
    ...(attemptSession.role === 'evaluator' ? { env: { GROK_MEMORY: '0' } } : {}),
    rateLimitRe: DEFAULT_RATE_LIMIT_RE,
    onStdoutChunk: tracker.consumeChunk,
    flush: tracker.flush,
    getSessionId: tracker.getSessionId,
    getStdoutTail: tracker.getStdoutTail,
    getProcessErrorText: tracker.getStreamError,
    getBody: () => Promise.resolve(Result.ok(tracker.getBody())),
    getUsage: () => ({ model: attemptSession.model, ...tracker.getUsage() }),
  });
};

export const createGrokProvider = (deps: HeadlessProviderDeps): HeadlessAiProvider =>
  createHeadlessProvider({
    providerSlug: 'grok',
    deps,
    resumeStaleRe: RESUME_STALE_RE,
    createGenerateContext: (base) => ({
      attempt: (attemptSession) => runGrokAttempt(attemptSession, base),
    }),
  });
