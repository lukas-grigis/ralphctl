import { dirname, join } from 'node:path';
import type { InteractiveAiProvider } from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { InteractiveProviderDeps } from '@src/integration/ai/providers/_engine/interactive-provider-deps.ts';
import { createInteractiveProvider } from '@src/integration/ai/providers/_engine/run-interactive-session.ts';
import { isGrokModel } from '@src/domain/value/settings-models/grok.ts';

/**
 * Interactive `grok` adapter. Spawns the Grok Build CLI with `stdio: 'inherit'` so the user sees
 * Grok's TUI directly.
 *
 *   grok --no-auto-update --trust --cwd <cwd> --sandbox off -m <model>
 *        --permission-mode acceptEdits --debug-file <unitDir>/grok-debug.log
 *        [--effort <level>] [-s <uuid>] <pointer at promptFile>
 *
 * Flag surface verified against Grok Build CLI 1.0.30's shipped CLI reference on 2026-09-15;
 * minimum supported version is 1.0.13, because `-s` lands there and is emitted unconditionally.
 *
 * `-s` sets the id of the session about to start — Claude's `--session-id`, not the resume flag.
 * The harness pre-generates it so it can mirror `sessionId.txt` for later re-attach; resume of an
 * existing session is the headless adapter's `-r <id>`.
 *
 * `--trust` is unconditional, and Grok's folder trust is UNIFIED: the one grant covers project
 * instructions (`AGENTS.md`), project skills (`.grok/skills`), project permission rules
 * (`.grok/config.toml`, `.claude/settings.json`), project hooks (`.grok/hooks/*.json`,
 * `.claude/settings.json`, `.cursor/hooks.json`) and repo-local MCP / LSP servers together
 * (10-hooks.md, 22-permissions-and-safety.md). ralphctl writes the `AGENTS.md` / `.grok/skills`
 * half itself and an untrusted folder skips it silently, so the grant is passed and the rest of
 * the blast radius accepted: the session runs the checkout's own hooks and repo-local MCP servers.
 * The posture is explicit — this runs a checkout the way you would by opening it in Grok yourself,
 * so run ralphctl only against repos you would trust there. Grok PERSISTS the decision in its
 * trust store, for the repo and for every per-task worktree path (a nested checkout is a separate
 * workspace). The interactive surface carries no read-only profile to gate:
 * `InteractiveAiProviderInput` has no `permissions` field on any backend, so there is no gate here
 * to mirror the headless `--deny` rules onto.
 *
 * `--prompt-file` is deliberately omitted — it forces headless. The prompt slot is a positional
 * pointer from `buildPromptPointer`, never the body.
 *
 * Grok has no `--add-dir`. `--sandbox off` is forced so extra roots (and `outputFile` outside
 * cwd) stay reachable — a named over-grant rather than an InvalidStateError (same posture as
 * the headless adapter).
 *
 * `--debug-file` is unconditional, and interactive is the surface that needs it most: with
 * `stdio: 'inherit'` the harness hands the child the terminal and can observe NOTHING about it —
 * no stdout to parse, no exit detail beyond a code. When a session hangs, the only account of
 * what happened is Grok's own. `~/.grok/logs/unified.jsonl` is not a substitute: it stops dead at
 * the last line the process managed to emit, so a stall there has to be inferred from what is
 * MISSING, which produced two confidently wrong root causes for the black-screen hang before this
 * landed. The debug log records `startup phase phase=<name>` transitions directly and names the
 * phase instead.
 *
 * Not behind a flag on purpose. The hang is intermittent (~1 in 3 launches), so a switch the
 * operator has to set BEFORE a session that may or may not hang collects evidence exactly when it
 * is not needed. Size works in the same direction: a stalled startup writes ~24 KB and stops,
 * while the ~600 KB a long healthy session produces is the case nobody needs to read. Both land
 * beside the session's other artifacts and are pruned with the rest of the unit.
 *
 * Docs: https://docs.x.ai/build/overview
 */

/** Name of the per-session Grok debug log, dropped beside `outputFile` / `sessionId.txt`. */
const DEBUG_LOG_FILENAME = 'grok-debug.log';

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
        '--trust',
        '--cwd',
        String(input.cwd),
        '--sandbox',
        'off',
        '-m',
        input.model,
        '--permission-mode',
        'acceptEdits',
        '--debug-file',
        join(dirname(String(input.outputFile)), DEBUG_LOG_FILENAME),
        ...(input.effort !== undefined ? ['--effort', input.effort] : []),
        ...(sessionId !== undefined ? ['-s', sessionId] : []),
        promptArg,
      ],
    },
    deps
  );
