import { Result } from '@src/domain/result.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import {
  FORENSIC_BODY_TAIL_CAP,
  RATE_LIMIT_SCAN_TAIL_CAP,
  createBoundedTail,
} from '@src/integration/ai/providers/_engine/bounded-tail.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { CopilotProviderDeps } from '@src/integration/ai/providers/_engine/copilot-provider-deps.ts';
import { resolveWritableRoots } from '@src/integration/ai/providers/_engine/resolve-roots.ts';
import type { SessionPermissions } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { isCopilotModel } from '@src/domain/value/settings-models/copilot.ts';
import { isSuspendedModel, suspendedModelMessage } from '@src/domain/value/settings-models/suspended-models.ts';
import { createCopilotStreamParser } from '@src/integration/ai/providers/copilot/parse-stream.ts';
import type { CopilotStreamLine, CopilotUsage } from '@src/integration/ai/providers/_engine/copilot-stream.ts';
import { type ProviderSpawn, defaultProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';
import { DEFAULT_RATE_LIMIT_RE } from '@src/integration/ai/providers/_engine/classify-spawn-exit.ts';
import { truncateField } from '@src/integration/ai/providers/_engine/truncate-debug-field.ts';
import {
  createHeadlessProvider,
  emitTokenUsage,
  runProviderAttempt,
} from '@src/integration/ai/providers/_engine/run-provider-attempt.ts';

/**
 * {@link HeadlessAiProvider} backed by the GitHub Copilot CLI (`copilot`, v1.0.12+).
 *
 * Translation table (intent → Copilot CLI flag):
 *
 *   | AiSession field                                       | Copilot flag                                       |
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
  const spawnFn: ProviderSpawn = deps.spawn ?? defaultProviderSpawn;
  const command = deps.command ?? 'copilot';

  return createHeadlessProvider({
    providerSlug: 'copilot',
    providerName: 'copilot-provider',
    resumeStaleRe: RESUME_STALE_RE,
    rateLimitRetries: deps.rateLimitRetries,
    eventBus: deps.eventBus,
    ...(deps.backoffSchedule !== undefined ? { backoffSchedule: deps.backoffSchedule } : {}),
    createGenerateContext: () => ({
      attempt: async (attemptSession) => {
        const built = buildCopilotArgs(attemptSession);
        if (!built.ok) return { kind: 'error', error: built.error };

        const parser = createCopilotStreamParser();
        // Two bounded tails fed in stream order — the forensic tail backs body.txt and the
        // rate-limit tail is the classifier's scan haystack. Both drop their oldest bytes once
        // full, so per-spawn stdout footprint is pinned regardless of child verbosity.
        const forensicTail = createBoundedTail(FORENSIC_BODY_TAIL_CAP);
        const rateLimitTail = createBoundedTail(RATE_LIMIT_SCAN_TAIL_CAP);
        const recordLine = (text: string): void => {
          forensicTail.append(`${text}\n`);
          rateLimitTail.append(`${text}\n`);
        };
        let sessionId: string | undefined;
        let model: string | undefined;
        let usage: CopilotUsage = {};

        const onLine = (line: CopilotStreamLine): void => {
          if (line.json !== undefined) {
            if (line.sessionId !== undefined && sessionId === undefined) {
              sessionId = line.sessionId;
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
              recordLine(line.bodyText);
              // Per-line assistant debug event.
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
              recordLine(line.raw);
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
          recordLine(line.raw);
        };

        return runProviderAttempt({
          spawnFn,
          command,
          args: built.value,
          session: attemptSession,
          resolveOn: 'exit',
          // Copilot reads the prompt from -p argv (no stdin payload); omitting `stdin` causes
          // runProviderAttempt to close the child's stdin immediately.
          rateLimitRe: DEFAULT_RATE_LIMIT_RE,
          onStdoutChunk: (chunk) => {
            parser.feed(chunk, onLine);
          },
          // Flush any partial line remaining in the buffer — Copilot may terminate without a
          // trailing newline. The parser drains inline so flush is a no-op in the normal case.
          flush: () => {
            parser.flush(onLine);
          },
          getSessionId: () => sessionId,
          // Feed the stream body tail into the rate-limit haystack — Copilot reports a quota
          // throttle in its result-record text, not on stderr. rateLimitTail is already bounded
          // to RATE_LIMIT_SCAN_TAIL_CAP, so a long session can't build a multi-MB scan string.
          getStdoutTail: () => {
            const tail = rateLimitTail.value();
            return tail.length > 0 ? tail : undefined;
          },
          // forensicTail is the accumulated body buffer; operators inspect it when a proposal
          // comes back empty to decide whether the prompt, the AI, or the validator is at fault.
          getBody: () => Promise.resolve(Result.ok(forensicTail.value())),
          emitProviderTokenUsage: (sid) => {
            emitTokenUsage(deps.eventBus, attemptSession, sid, {
              provider: 'github-copilot',
              ...(model !== undefined ? { model } : {}),
              ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
              ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
            });
          },
          providerName: 'copilot-provider',
          providerSlug: 'copilot',
          eventBus: deps.eventBus,
          ...(deps.idleMs !== undefined ? { idleMs: deps.idleMs } : {}),
        });
      },
    }),
  });
};
