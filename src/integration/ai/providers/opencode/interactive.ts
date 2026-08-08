import type { InteractiveAiProvider } from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { InteractiveProviderDeps } from '@src/integration/ai/providers/_engine/interactive-provider-deps.ts';
import { createInteractiveProvider } from '@src/integration/ai/providers/_engine/run-interactive-session.ts';
import { isOpencodeModelIdShape } from '@src/domain/value/settings-models/opencode.ts';

/**
 * Interactive `opencode` adapter. Spawns the OpenCode TUI with `stdio: 'inherit'` so the user
 * chats directly.
 *
 *   opencode <cwd> --model <provider/model> --prompt <pointer at promptFile, or the body>
 *
 * OpenCode's default command takes the project directory as its positional argument (`opencode
 * [project]`) rather than a `--cd`-style flag, and starts the TUI. Unlike codex there is no
 * POSITIONAL prompt slot on that command, but the default command does expose `--prompt <string>`
 * and submits it the moment the TUI launches (verified against opencode-ai v1.18.15) — so the
 * harness's rendered prompt, which carries the audit-[09] contract section, is forwarded.
 *
 * `input.effort` is deliberately NOT forwarded: `--variant` exists only on the `opencode run`
 * subcommand, and the default TUI command is yargs-strict — it exits 1 with a usage banner on an
 * unknown flag. Since an operator can legitimately set an effort on an opencode row, forwarding it
 * here would turn a working session into a hard spawn failure. Dropping it is the correct trade.
 *
 * `isKnownModel` checks the `provider/model` SHAPE rather than catalog membership: OpenCode
 * aggregates upstream providers, so which concrete ids are reachable depends on the operator's
 * `opencode providers` auth state and cannot be known statically. See the note on
 * `domain/value/settings-models/opencode.ts`.
 *
 * There is no `--add-dir` equivalent, so `roots` cannot be mounted — the single positional
 * project directory is the whole topology, which is what `mountsRoots: false` declares. The
 * consequence is that OpenCode only gets the prompt POINTER when the prompt file already lives
 * under `cwd` (plan, refine); with a repository as cwd (ideate, memory-distill) the file is
 * unreachable and the engine falls back to the inlined body with a warning, since a session that
 * cannot read its own brief is worse than a large argv. See `_engine/prompt-pointer.ts`.
 *
 * Session ids are minted by OpenCode itself and only
 * surface on the `run` JSON stream (not on the TUI path), so `supportsSessionId` stays false and
 * subscribers fall back to the runner's session id, matching the codex adapter.
 *
 * Docs: https://opencode.ai/docs/cli/
 */
export const createInteractiveOpencodeProvider = (deps: InteractiveProviderDeps): InteractiveAiProvider =>
  createInteractiveProvider(
    {
      providerName: 'interactive-opencode',
      defaultCommand: 'opencode',
      modelCatalogLabel: 'OpenCode',
      isKnownModel: isOpencodeModelIdShape,
      supportsSessionId: false,
      mountsRoots: false,
      buildArgs: (input, { promptArg }) => [String(input.cwd), '--model', input.model, '--prompt', promptArg],
    },
    deps
  );
