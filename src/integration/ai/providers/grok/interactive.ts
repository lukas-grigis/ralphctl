import type { InteractiveAiProvider } from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { InteractiveProviderDeps } from '@src/integration/ai/providers/_engine/interactive-provider-deps.ts';
import { createInteractiveProvider } from '@src/integration/ai/providers/_engine/run-interactive-session.ts';
import { isGrokModel } from '@src/domain/value/settings-models/grok.ts';

/**
 * Interactive `grok` adapter. Spawns the Grok Build CLI with `stdio: 'inherit'` so the user sees
 * Grok's TUI directly.
 *
 *   grok --no-auto-update --cwd <cwd> -m <model> --permission-mode acceptEdits
 *        [--effort <level>] [-s <uuid>] <pointer at promptFile>
 *
 * `--prompt-file` is deliberately omitted — it forces headless. The prompt slot is a positional
 * pointer from `buildPromptPointer`, never the body.
 *
 * Grok has no `--add-dir`. With sandbox off, extra roots are a named over-grant rather than an
 * InvalidStateError (same posture as the headless adapter).
 *
 * Docs: https://docs.x.ai/build/overview
 */
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
