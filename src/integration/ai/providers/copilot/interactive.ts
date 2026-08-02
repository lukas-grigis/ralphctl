import type { InteractiveAiProvider } from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { InteractiveProviderDeps } from '@src/integration/ai/providers/_engine/interactive-provider-deps.ts';
import { createInteractiveProvider } from '@src/integration/ai/providers/_engine/run-interactive-session.ts';
import { isCopilotModel } from '@src/domain/value/settings-models/copilot.ts';

/**
 * Interactive `copilot` adapter. Spawns the GitHub Copilot CLI with `stdio: 'inherit'` so the user
 * sees the TUI directly. Copilot's interactive form takes a pre-seeded prompt via `-i PROMPT`, and
 * the prompt content is passed directly as argv — the earlier `bash -lc "… $(cat …)"` form
 * silently dropped the seed for some users (the TUI opened at an empty input box).
 *
 *   copilot --add-dir=<root>... --model=<model> --allow-all-tools --session-id=<uuid>
 *           [--effort=<level>] -i <prompt>
 *
 * `--add-dir` / `--model` / `--session-id` / `--effort` are equals-only per the CLI reference;
 * passing them space-separated leaves the parser without a bound value.
 *
 * Permission strategy: `--allow-all-tools` so the AI isn't blocked on per-tool confirmation
 * prompts (read, search, shell) before it can consume the seeded prompt. The user still owns the
 * terminal and can stop the session at any time; the harness's read-side is post-session.
 *
 * Docs: https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference
 */
export const createInteractiveCopilotProvider = (deps: InteractiveProviderDeps): InteractiveAiProvider =>
  createInteractiveProvider(
    {
      providerName: 'interactive-copilot',
      defaultCommand: 'copilot',
      modelCatalogLabel: 'Copilot',
      isKnownModel: isCopilotModel,
      supportsSessionId: true,
      buildArgs: (input, { prompt, roots, sessionId }) => [
        ...roots.map((p) => `--add-dir=${p}`),
        `--model=${input.model}`,
        '--allow-all-tools',
        ...(sessionId !== undefined ? [`--session-id=${sessionId}`] : []),
        // Forward the resolved effort verbatim — the CLI rejects unknown levels itself, so
        // re-validating here would only duplicate its catalog (mirrors the headless adapter).
        ...(input.effort !== undefined ? [`--effort=${input.effort}`] : []),
        '-i',
        prompt,
      ],
    },
    deps
  );
