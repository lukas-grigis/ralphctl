import type { InteractiveAiProvider } from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { InteractiveProviderDeps } from '@src/integration/ai/providers/_engine/interactive-provider-deps.ts';
import { createInteractiveProvider } from '@src/integration/ai/providers/_engine/run-interactive-session.ts';
import { isOpencodeModelIdShape } from '@src/domain/value/settings-models/opencode.ts';

/**
 * Interactive `opencode` adapter. Spawns the OpenCode TUI with `stdio: 'inherit'` so the user
 * chats directly.
 *
 *   opencode <cwd> --model <provider/model>
 *
 * OpenCode's default command takes the project directory as its positional argument (`opencode
 * [project]`) rather than a `--cd`-style flag, and starts the TUI. Unlike codex there is no
 * positional prompt slot on that command — the harness's opening prompt is therefore not
 * forwarded, and the user types their first message in the TUI.
 *
 * `isKnownModel` checks the `provider/model` SHAPE rather than catalog membership: OpenCode
 * aggregates upstream providers, so which concrete ids are reachable depends on the operator's
 * `opencode providers` auth state and cannot be known statically. See the note on
 * `domain/value/settings-models/opencode.ts`.
 *
 * There is no `--add-dir` equivalent, so `roots` cannot be mounted — the single positional
 * project directory is the whole topology. Session ids are minted by OpenCode itself and only
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
      buildArgs: (input) => [String(input.cwd), '--model', input.model],
    },
    deps
  );
