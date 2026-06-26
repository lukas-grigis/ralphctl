import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { crossPlatformSpawn } from '@src/integration/io/cross-platform-spawn.ts';
import { Result } from '@src/domain/result.ts';
import type { HeadlessAiProvider, ProviderOutput } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import {
  RATE_LIMIT_SCAN_TAIL_CAP,
  STDERR_TAIL_CAP,
  createBoundedTail,
} from '@src/integration/ai/providers/_engine/bounded-tail.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { CopilotProviderDeps } from '@src/integration/ai/providers/_engine/copilot-provider-deps.ts';
import { resolveWritableRoots } from '@src/integration/ai/providers/_engine/resolve-roots.ts';
import type { SessionPermissions } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { isCopilotModel } from '@src/domain/value/settings-models/copilot.ts';
import { isSuspendedModel, suspendedModelMessage } from '@src/domain/value/settings-models/suspended-models.ts';
import { createCopilotStreamParser } from '@src/integration/ai/providers/copilot/parse-stream.ts';
import type { CopilotStreamLine, CopilotUsage } from '@src/integration/ai/providers/_engine/copilot-stream.ts';
import type { ProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';
import { runHeadlessSpawn } from '@src/integration/ai/providers/_engine/run-headless-spawn.ts';
import { runWithRateLimitRetry } from '@src/integration/ai/providers/_engine/run-with-rate-limit-retry.ts';
import type { AttemptOutcome } from '@src/integration/ai/providers/_engine/attempt-outcome.ts';
import { DEFAULT_RATE_LIMIT_RE, classifySpawnExit } from '@src/integration/ai/providers/_engine/classify-spawn-exit.ts';
import { writeTextAtomic } from '@src/integration/io/fs.ts';
import { persistSessionIdFile } from '@src/integration/ai/providers/_engine/persist-session-id.ts';
import { contextWindowFor } from '@src/integration/ai/providers/_engine/context-window.ts';
import { truncateField } from '@src/integration/ai/providers/_engine/truncate-debug-field.ts';

/**
 * {@link HeadlessAiProvider} backed by the GitHub Copilot CLI (`copilot`, v1.0.12+).
 *
 * Translation table (intent → Copilot CLI flag):
 *
 *   | AiSession field                                       | Copilot flag                                       |
 *   | ----------------------------------------------------- | -------------------------------------------------- |
 *   | (always)                                              | `--output-format=json --silent --no-ask-user`      |
 *   | model: <CopilotModel>                                 | `--model=<model>`                                  |
 *   | additionalRoots: [a, b]                               | `--add-dir=a --add-dir=b`                          |
 *   | permissions {autoApprove,canModifyRepoFiles,canRunShell}    | `--allow-all`                                      |
 *   | permissions read-only (no edit, no shell)             | `--allow-all-tools --deny-tool=shell`              |
 *   | resume: <id>                                          | `--resume=<id>`                                    |
 *   | effort: <level>                                       | `--effort=<level>`                                 |
 *   | prompt                                                | argv: `-p <prompt>`                                |
 *
 * Resume note: current Copilot CLI accepts `--resume[=VALUE]` with `-p` / `--prompt`.
 * The adapter forwards {@link AiSession.resume} when present so headless runs can re-attach
 * to a prior session id.
 *
 * Copilot's prompt is passed as a CLI argument (`-p <text>`) rather than piped via stdin.
 * Argv length is the OS limit (~2MB on macOS); revisit if a chain hits it.
 *
 * Read-only permission denies `shell` only — the `write` tool stays open because the
 * audit-[09] contract requires the AI to land `signals.json` in `outputDir` via Copilot's
 * write tool. Copilot has no fine-grained "may write new files but not edit existing ones"
 * gate (the `write` kind covers all file mutations), so path scope (cwd + --add-dir) carries
 * the responsibility of keeping the AI inside its sandbox.
 *
 * Output handling — audit-[09] contract: stdout JSONL is consumed by
 * {@link createCopilotStreamParser}. Plain-text lines accumulate into a transient body buffer;
 * JSON records expose the `session_id` (logged + returned). The AI writes `signals.json`
 * directly via its Write tool into `session.outputDir`; the harness validates it post-spawn —
 * the provider never touches signals.json. When `session.bodyFile` is set, the raw accumulated
 * body is mirrored there for forensic capture — best-effort, a write failure here is logged
 * but does not fail the spawn.
 *
 * Per-line debug events: the headless adapter publishes one
 * `{ type: 'log', level: 'debug', message: 'copilot-provider: assistant' }` event per
 * recognised assistant body line (driven off `CopilotStreamLine.bodyText`, which the parser
 * extracts from `assistant.message_delta` / `assistant.message` and the speculative SSE shapes
 * in `parse-stream.ts`). The Copilot CLI's `--output-format=json` stream as of 1.0.51 does
 * NOT surface `tool_use` / `tool_result` records in any shape the adapter can recognise — tool
 * invocations are flattened into the `assistant.message` text body. The adapter therefore
 * emits the assistant analogue only; the tool_use / tool_result analogues described in the
 * shared per-line debug contract simply have no source in Copilot's stream JSON. Re-audit when
 * a future Copilot release surfaces structured tool records (compare against
 * `_engine/copilot-stream.ts` and `parse-stream.ts`).
 *
 * Test seam: `spawn` is a {@link ProviderSpawn} override so tests script stdout / stderr /
 * exit code without launching the real binary.
 *
 * Docs:
 *   - https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference
 *   - https://docs.github.com/en/copilot/how-tos/copilot-cli/allowing-tools (tool-kind syntax)
 *
 * Composition-root inputs ({@link CopilotProviderDeps}) live in `_engine/` so the contract is
 * a port, not an implementation detail of this file.
 */

/**
 * Cold-start fallback trigger: Copilot rejects a `--resume <id>` whose session it no longer has.
 * The CLI's exact wording for an unknown resume id is not formally documented, so this is kept
 * conservative — it matches a "session/conversation … not found" phrasing only. The shared retry
 * seam drops `--resume` for one cold respawn (latched) rather than hard-failing the round.
 */
const RESUME_STALE_RE = /(session|conversation)[^\n]*not found|no (session|conversation) found/i;

const isFullAuto = (p: SessionPermissions): boolean => p.autoApprove && p.canModifyRepoFiles && p.canRunShell;

/**
 * Build the argv for one Copilot invocation. Validates `session.model` is a known
 * {@link CopilotModel}; surfaces `InvalidStateError` for unknowns.
 */
export const buildCopilotArgs = (session: AiSession): Result<readonly string[], InvalidStateError> => {
  if (!isCopilotModel(session.model)) {
    return Result.error(
      new InvalidStateError({
        entity: 'copilot-provider',
        currentState: 'model-validation',
        attemptedAction: 'build argv',
        message: `copilot-provider: '${session.model}' is not a known Copilot model`,
      })
    );
  }
  // Catalog-valid but temporarily suspended server-side (see suspended-models.ts). For Copilot
  // this hits the Anthropic-served claude-fable-5 entry — fail fast with a clear message.
  if (isSuspendedModel(session.model)) {
    return Result.error(
      new InvalidStateError({
        entity: 'copilot-provider',
        currentState: 'model-suspended',
        attemptedAction: 'build argv',
        message: suspendedModelMessage(session.model),
      })
    );
  }
  // `--autopilot` is required for autonomous continuation; without it Copilot may pause
  // between actions in non-interactive mode and never finish the turn. v1's working headless
  // adapter sets this flag too — keeping the patterns aligned across versions.
  //
  // `--max-autopilot-continues=200` raises the per-spawn turn budget far above Copilot's
  // default of 5. An implement-flow generator routinely takes 10+ tool calls (read,
  // think, edit, verify, edit again, …) before emitting `task-complete`; the default cap
  // truncates mid-task and signals.json never lands. 200 leaves headroom for the largest
  // realistic per-task action graph while still bounding pathological runaway. Bump if
  // pathologically long tasks hit it.
  //
  // We use `--model=<value>` / `--add-dir=<value>` for deterministic argv construction.
  const args: string[] = [
    '--output-format=json',
    '--autopilot',
    '--max-autopilot-continues=200',
    '--silent',
    '--no-ask-user',
    `--model=${session.model}`,
  ];
  if (session.resume !== undefined) {
    args.push(`--resume=${String(session.resume)}`);
  }
  // Forward `session.effort` verbatim using the `=` form to match the rest of copilot's
  // argv style. The Copilot CLI's `--effort` flag rejects unknown levels — let it speak for
  // itself rather than re-validate here. Compatible with `--autopilot`.
  if (session.effort !== undefined) {
    args.push(`--effort=${session.effort}`);
  }
  if (isFullAuto(session.permissions)) {
    args.push('--allow-all');
  } else {
    // Read-only / partial permissions → allow all tool kinds, then deny shell only. Write
    // tool stays open because the contract envelope (signals.json) lands via that tool;
    // path scope (cwd + --add-dir) is what keeps it pointed at outputDir. Without the
    // explicit allow, non-denied tools (read, search, write) would hit per-call confirmation
    // prompts which `--no-ask-user` turns into refusals.
    args.push('--allow-all-tools', '--deny-tool=shell');
  }
  // Auto-mount `outputDir` so signals.json can land via the write tool. See resolve-roots.ts.
  for (const root of resolveWritableRoots(session)) {
    args.push(`--add-dir=${String(root)}`);
  }
  args.push('-p', session.prompt);
  return Result.ok(args);
};

export const createCopilotProvider = (deps: CopilotProviderDeps): HeadlessAiProvider => {
  const spawnFn: ProviderSpawn = deps.spawn ?? defaultSpawn;
  const command = deps.command ?? 'copilot';

  return {
    async generate(session) {
      // Validate argv up front so a bad model surfaces before any spawn.
      const argsResult = buildCopilotArgs(session);
      if (!argsResult.ok) return Result.error(argsResult.error) as Result<ProviderOutput, DomainError>;

      // The shared retry seam owns the loop, backoff, banners, abort-during-backoff, the
      // session-resume rebuild (so a 429 retry passes `--resume <id>`), and the stale-resume
      // cold fallback. The per-attempt closure rebuilds argv from the CURRENT session.
      return runWithRateLimitRetry({
        session,
        rateLimitRetries: deps.rateLimitRetries,
        ...(deps.backoffSchedule !== undefined ? { backoffSchedule: deps.backoffSchedule } : {}),
        eventBus: deps.eventBus,
        providerSlug: 'copilot',
        providerName: 'copilot-provider',
        resumeStaleRe: RESUME_STALE_RE,
        attempt: async (attemptSession) => {
          const built = buildCopilotArgs(attemptSession);
          if (!built.ok) return { kind: 'error', error: built.error };
          return spawnAttempt({ deps, spawnFn, command, args: built.value, session: attemptSession });
        },
      });
    },
  };
};

interface SpawnAttemptArgs {
  readonly deps: CopilotProviderDeps;
  readonly spawnFn: ProviderSpawn;
  readonly command: string;
  readonly args: readonly string[];
  readonly session: AiSession;
}

const spawnAttempt = async (input: SpawnAttemptArgs): Promise<AttemptOutcome> => {
  const { deps, spawnFn, command, args, session } = input;
  // `cwd` is critical — the Copilot CLI only auto-discovers `.github/copilot-instructions.md`,
  // skills, agents, and `.mcp.json` from the child's `process.cwd()`. Without this, the
  // native context-file pipeline silently misses and the AI runs without project guidance.
  // See CLAUDE.md §Security — "Cwd is the repo because Claude / Copilot / Codex only
  // auto-discover their context file from cwd."
  const child = spawnFn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] as const, cwd: String(session.cwd) });
  const parser = createCopilotStreamParser();
  // Two buffers, one tagged event log: assistant body text feeds signal parsing; the
  // forensic body.txt mirrors every assistant + unrecognised-event line in stream order.
  // Splitting matters because Copilot echoes the prompt as a `user.message` event whose raw
  // JSONL would otherwise be matched by the harness signal regexes (literal `<task-blocked>`
  // inside the prompt → fake signal). Order preservation: derive both views from one tagged
  // event list rather than two parallel arrays.
  const events: Array<{ readonly assistant: boolean; readonly text: string }> = [];
  let sessionId: string | undefined;
  let model: string | undefined;
  let usage: CopilotUsage = {};
  const stderrTail = createBoundedTail(STDERR_TAIL_CAP);

  // Bound once so onIdle's banner-show id and the classifier's banner-clear id match.
  const watchdogBannerId = `watchdog-copilot-${String(child.pid ?? 'unknown')}`;

  const onLine = (line: CopilotStreamLine): void => {
    if (line.json !== undefined) {
      if (line.sessionId !== undefined && sessionId === undefined) {
        sessionId = line.sessionId;
        deps.eventBus.publish({
          type: 'log',
          level: 'debug',
          message: 'copilot-provider: session id captured',
          meta: { sessionId },
          at: IsoTimestamp.now(),
        });
      }
      if (line.model !== undefined && model === undefined) {
        model = line.model;
      }
      // Last-write-wins on usage. Copilot occasionally emits multiple meta lines through a
      // spawn; whichever lands last is the most current cumulative count.
      if (line.usage !== undefined) {
        usage = line.usage;
      }
      if (line.bodyText !== undefined && line.bodyText.length > 0) {
        events.push({ assistant: true, text: line.bodyText });
        // Per-line assistant debug event. The bus → logger consumer drops debug events at
        // the default `info` floor; only `RALPHCTL_LOG_LEVEL=debug` operators see them.
        const text = truncateField(line.bodyText);
        if (text !== undefined) {
          deps.eventBus.publish({
            type: 'log',
            level: 'debug',
            message: 'copilot-provider: assistant',
            meta: { text },
            at: IsoTimestamp.now(),
          });
        }
      } else if (line.sessionId === undefined && line.model === undefined && line.usage === undefined) {
        // Unrecognised JSON event — keep the raw form so `body.txt` (when bodyFile is set)
        // captures Copilot's actual stream shapes. NEVER feed this to the signal parser:
        // Copilot echoes the prompt as `user.message`, which carries literal harness tags.
        events.push({ assistant: false, text: line.raw });
      }
      // Truncate the raw line like every other stream-originated debug field (see truncateField):
      // at the debug floor this fires per stdout line, so an untruncated raw envelope would bloat
      // each capped log-bus entry. The full raw stream is still captured in bodyFile when set.
      const rawLine = truncateField(line.raw);
      deps.eventBus.publish({
        type: 'log',
        level: 'debug',
        message: 'copilot-provider: stdout json line',
        ...(rawLine !== undefined ? { meta: { raw: rawLine } } : {}),
        at: IsoTimestamp.now(),
      });
      return;
    }
    // Non-JSON lines (banner/status); preserve in body.txt but keep out of signal parsing.
    events.push({ assistant: false, text: line.raw });
  };

  // Copilot reads the prompt from -p argv (no stdin payload). Tokens stream to stdout via the
  // ndjson `parser`; we wait for `'exit'` since the parser drains everything it sees inline.
  const { code, signal } = await runHeadlessSpawn({
    child,
    onStdout: (chunk) => parser.feed(chunk, onLine),
    onStderr: (chunk) => {
      stderrTail.append(chunk);
    },
    resolveOn: 'exit',
    ...(deps.idleMs !== undefined ? { idleMs: deps.idleMs } : {}),
    ...(session.abortSignal !== undefined ? { abortSignal: session.abortSignal } : {}),
    onIdle: () => {
      const idleMs = deps.idleMs ?? undefined;
      deps.eventBus.publish({
        type: 'log',
        level: 'warn',
        message: `copilot-provider: no stdio activity${idleMs !== undefined ? ` for ${String(idleMs)}ms` : ''} — killing wedged child`,
        ...(idleMs !== undefined ? { meta: { idleMs } } : {}),
        at: IsoTimestamp.now(),
      });
      deps.eventBus.publish({
        type: 'banner-show',
        id: watchdogBannerId,
        tier: 'warn',
        message: `Watchdog killed stuck copilot process${idleMs !== undefined ? ` (${String(Math.round(idleMs / 1000))}s idle)` : ''}`,
        at: IsoTimestamp.now(),
      });
    },
  });
  parser.flush(onLine);

  const onSuccess = async (): Promise<AttemptOutcome> => {
    // audit-[09]: the AI writes `signals.json` directly via its Write tool into
    // `session.outputDir`; the harness validates it post-spawn. The provider never writes
    // signals.json itself. The forensic body buffer below stays — operators inspect it when
    // a proposal comes back empty to decide whether the prompt, the AI, or the validator is
    // at fault. On SIGTERM-recovery `events[]` may be partial; the join still produces a
    // useful snapshot of what the model emitted before the watchdog stepped in.
    const forensicBody = events.map((e) => e.text).join('\n');
    // Mirror raw body for diagnostic capture. Best-effort: a write failure here is logged but
    // does not fail the session. Critically, the body is captured even when the AI emits no
    // signals, so operators can see what the model actually produced.
    if (session.bodyFile !== undefined) {
      const bodyWrote = await writeTextAtomic(String(session.bodyFile), forensicBody);
      if (!bodyWrote.ok) {
        deps.eventBus.publish({
          type: 'log',
          level: 'warn',
          message: `copilot-provider: failed to write body file — diagnostic capture skipped`,
          meta: { bodyFile: String(session.bodyFile), error: bodyWrote.error.message },
          at: IsoTimestamp.now(),
        });
      }
    }
    if (sessionId !== undefined) {
      // Emit one TokenUsageEvent per success spawn — even when Copilot omits usage
      // counters from the meta line, sessionId + provider + (maybe) model is still useful for
      // a TUI widget that correlates rounds with provider sessions. Honest about absent fields.
      const window = contextWindowFor(model);
      const chainSessionId = session.chainSessionId;
      deps.eventBus.publish({
        type: 'token-usage',
        sessionId,
        ...(chainSessionId !== undefined ? { chainSessionId } : {}),
        provider: 'github-copilot',
        ...(model !== undefined ? { model } : {}),
        ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
        ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
        ...(window !== undefined ? { contextWindow: window } : {}),
        ...(session.role !== undefined ? { role: session.role } : {}),
        at: IsoTimestamp.now(),
      });
    }
    // Persist captured session id as a sibling `sessionId` file. Copilot 1.0.51 emits the id as
    // `sessionId` on the TRAILING `{type:"result"}` record (not a leading meta line); the parser
    // captures it via first-`sessionId`-wins, and only that record carries the key so there is no
    // false positive. If missing (banner-only streams, crash before the result record) we skip
    // rather than write an empty marker. See persistSessionIdFile for the contract.
    const sidWrote = await persistSessionIdFile(session.signalsFile, sessionId);
    if (sidWrote !== undefined && !sidWrote.ok) {
      deps.eventBus.publish({
        type: 'log',
        level: 'warn',
        message: `copilot-provider: failed to write sessionId file — resume re-attach may need log parsing`,
        meta: { error: sidWrote.error.message },
        at: IsoTimestamp.now(),
      });
    }
    return {
      kind: 'success',
      output: {
        signalsFile: session.signalsFile,
        exitCode: code ?? 0,
        ...(sessionId !== undefined ? { sessionId } : {}),
      },
    };
  };

  // Feed the stream body tail into the rate-limit haystack — Copilot reports a quota throttle in
  // its result-record text (captured as a raw `events[]` line), not on stderr. Capped so a long
  // session doesn't build a multi-MB scan string.
  const stdoutTail = events
    .map((e) => e.text)
    .join('\n')
    .slice(-RATE_LIMIT_SCAN_TAIL_CAP);

  return classifySpawnExit({
    session,
    exit: { code, signal },
    stderr: stderrTail.value(),
    rateLimitRe: DEFAULT_RATE_LIMIT_RE,
    ...(stdoutTail.length > 0 ? { stdoutTail } : {}),
    ...(sessionId !== undefined ? { capturedSessionId: sessionId } : {}),
    providerName: 'copilot-provider',
    eventBus: deps.eventBus,
    watchdogBannerId,
    onSuccess,
  });
};

const defaultSpawn: ProviderSpawn = (command, args, options) =>
  crossPlatformSpawn(command, args, {
    stdio: [...options.stdio],
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
  }) as ChildProcessWithoutNullStreams;
