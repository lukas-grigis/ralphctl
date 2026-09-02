import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InteractiveAiProvider } from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { InteractiveProviderDeps } from '@src/integration/ai/providers/_engine/interactive-provider-deps.ts';
import { createInteractiveProvider } from '@src/integration/ai/providers/_engine/run-interactive-session.ts';
import { isGrokModel } from '@src/domain/value/settings-models/grok.ts';

/**
 * Interactive `grok` adapter. Spawns the Grok Build CLI with `stdio: 'inherit'` so the user sees
 * Grok's TUI directly.
 *
 *   grok --no-auto-update --cwd <cwd> --sandbox off --no-alt-screen
 *        --leader-socket <tmp>/ralphctl-grok-<id>.sock -m <model>
 *        --permission-mode acceptEdits [--effort <level>] [-s <uuid>] <pointer at promptFile>
 *
 * `-s` (grok 1.0.13) sets the id of the session about to start — Claude's `--session-id`, not the
 * resume flag. The harness pre-generates it so it can mirror `sessionId.txt` for later re-attach;
 * resume of an existing session is the headless adapter's `-r <id>`.
 *
 * `--prompt-file` is deliberately omitted — it forces headless. The prompt slot is a positional
 * pointer from `buildPromptPointer`, never the body.
 *
 * `--leader-socket` is the one Grok-specific piece of session isolation. Grok's agent runs behind
 * a leader process reached over `~/.grok/leader.sock` by default, and it kills discovered leaders
 * at startup (`leader.startup_kill`); sharing that socket lets a harness-launched session and a
 * long-lived interactive Grok the user already has open tear each other down. A per-session path
 * keeps them apart. It is derived from the session id the engine already generates rather than
 * from a staged temp directory: the path is the only thing needed, Grok binds the socket itself,
 * and the short `<id>` suffix keeps the name clear of the 104-byte macOS `sun_path` limit even
 * under a long `TMPDIR`.
 *
 * `--no-alt-screen` keeps Grok inline after Ink's `suspendTerminal` has already left the
 * alternate screen.
 *
 * Grok has no `--add-dir`. `--sandbox off` is forced so extra roots (and `outputFile` outside
 * cwd) stay reachable — a named over-grant rather than an InvalidStateError (same posture as
 * the headless adapter).
 *
 * Docs: https://docs.x.ai/build/overview
 */

/**
 * Per-session leader socket path. Keyed off the engine's session id so no state has to be threaded
 * from `run` into `buildArgs`; the tail is enough to be unique per session while staying short
 * (`/var/folders/…/T/` already spends ~48 of the 104 bytes a unix socket path may occupy). The pid
 * fallback cannot be reached while `supportsSessionId` is true, and keeps concurrent harnesses
 * apart rather than collapsing them onto one shared path if it ever is.
 */
const leaderSocketFor = (sessionId: string | undefined): string =>
  join(tmpdir(), `ralphctl-grok-${(sessionId ?? String(process.pid)).slice(-8)}.sock`);

export const createInteractiveGrokProvider = (deps: InteractiveProviderDeps): InteractiveAiProvider =>
  createInteractiveProvider(
    {
      providerName: 'interactive-grok',
      defaultCommand: 'grok',
      modelCatalogLabel: 'Grok',
      isKnownModel: isGrokModel,
      supportsSessionId: true,
      buildArgs: (input, { promptArg, sessionId }) => [
        '--no-auto-update',
        '--cwd',
        String(input.cwd),
        '--sandbox',
        'off',
        '--no-alt-screen',
        '--leader-socket',
        leaderSocketFor(sessionId),
        '-m',
        input.model,
        '--permission-mode',
        'acceptEdits',
        ...(input.effort !== undefined ? ['--effort', input.effort] : []),
        ...(sessionId !== undefined ? ['-s', sessionId] : []),
        promptArg,
      ],
    },
    deps
  );
