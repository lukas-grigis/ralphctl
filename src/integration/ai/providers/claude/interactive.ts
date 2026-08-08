import type { InteractiveAiProvider } from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { InteractiveProviderDeps } from '@src/integration/ai/providers/_engine/interactive-provider-deps.ts';
import { createInteractiveProvider } from '@src/integration/ai/providers/_engine/run-interactive-session.ts';
import { isClaudeModel } from '@src/domain/value/settings-models/claude.ts';

/**
 * Interactive `claude` adapter. Spawns the Claude CLI with `stdio: 'inherit'` so the user sees
 * Claude's UI directly and can type answers to its `AskUserQuestion` prompts. The harness has no
 * read-side on stdout while the user owns the terminal — Claude is told to write its final answer
 * to the caller's `outputFile`, which the caller reads back after the session resolves.
 *
 *   claude --add-dir <cwd> --add-dir <dirname(outputFile)> [--add-dir <extra>...]
 *          --model <model> --permission-mode acceptEdits --session-id <uuid>
 *          [--effort <level>] <pointer at promptFile>
 *
 * The prompt slot carries a pointer at the rendered prompt file, never its body — see
 * `_engine/prompt-pointer.ts`. `--add-dir` mounts the file's directory, so the pointer always
 * resolves.
 *
 * Permission strategy: `acceptEdits` auto-approves the `Edit` / `Write` tools — but only for paths
 * inside one of the `--add-dir` roots, which is why the engine mounts the prompt / output
 * directories alongside `cwd`.
 *
 * Docs: https://code.claude.com/docs/en/cli-reference (`claude "query"` interactive form,
 * `--permission-mode acceptEdits`, `--add-dir`, `--model`, `--effort`).
 */
export const createInteractiveClaudeProvider = (deps: InteractiveProviderDeps): InteractiveAiProvider =>
  createInteractiveProvider(
    {
      providerName: 'interactive-claude',
      defaultCommand: 'claude',
      modelCatalogLabel: 'Claude',
      isKnownModel: isClaudeModel,
      supportsSessionId: true,
      buildArgs: (input, { promptArg, roots, sessionId }) => [
        ...roots.flatMap((p) => ['--add-dir', p]),
        '--model',
        input.model,
        '--permission-mode',
        'acceptEdits',
        ...(sessionId !== undefined ? ['--session-id', sessionId] : []),
        // Forward the resolved effort verbatim — the CLI rejects unknown levels itself, so
        // re-validating here would only duplicate its catalog (mirrors the headless adapter).
        ...(input.effort !== undefined ? ['--effort', input.effort] : []),
        promptArg,
      ],
    },
    deps
  );
