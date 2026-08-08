import type { InteractiveAiProvider } from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { InteractiveProviderDeps } from '@src/integration/ai/providers/_engine/interactive-provider-deps.ts';
import { createInteractiveProvider } from '@src/integration/ai/providers/_engine/run-interactive-session.ts';
import { isCodexModel } from '@src/domain/value/settings-models/codex.ts';

/**
 * Interactive `codex` adapter. Spawns the Codex CLI with `stdio: 'inherit'` so the user sees the
 * TUI directly and can chat. Codex's top-level (non-`exec`) command starts the TUI and accepts an
 * optional positional prompt — `codex "explain this codebase"`.
 *
 *   codex --cd <cwd> --add-dir <root>... --model <model> -s workspace-write -a never
 *         [-c model_reasoning_effort=<level>] <pointer at promptFile>
 *
 * The positional prompt slot carries a pointer at the rendered prompt file, never its body — see
 * `_engine/prompt-pointer.ts`. `--add-dir` mounts the file's directory, so the pointer always
 * resolves.
 *
 * `-s workspace-write -a never` matches Claude's `--permission-mode acceptEdits` intent: writes
 * inside a mounted root run without a confirmation step, so the AI can drop its answer in
 * `outputFile`. `-a never` makes the sandbox the only gate — anything outside the mounted roots
 * fails immediately rather than prompting, which is correct because the harness pre-declares every
 * legal write path via `--cd` + `--add-dir`.
 *
 * Codex accepts no harness-supplied session id at launch (`--session-id` exists only on its
 * `resume` / `fork` subcommands, as a lookup key for an existing session), so this adapter leaves
 * the port's `sessionId` unset — subscribers fall back to the runner's session id.
 *
 * Docs: https://developers.openai.com/codex/cli/reference (top-level `codex` flags).
 */
export const createInteractiveCodexProvider = (deps: InteractiveProviderDeps): InteractiveAiProvider =>
  createInteractiveProvider(
    {
      providerName: 'interactive-codex',
      defaultCommand: 'codex',
      modelCatalogLabel: 'Codex',
      isKnownModel: isCodexModel,
      supportsSessionId: false,
      mountsRoots: true,
      buildArgs: (input, { promptArg, roots }) => [
        '--cd',
        String(input.cwd),
        ...roots.flatMap((p) => ['--add-dir', p]),
        '--model',
        input.model,
        '-s',
        'workspace-write',
        '-a',
        'never',
        // Forward the resolved effort verbatim — the CLI rejects unknown or model-incompatible
        // levels itself, so re-validating here would only duplicate its catalog (mirrors the
        // headless adapter).
        ...(input.effort !== undefined ? ['-c', `model_reasoning_effort=${input.effort}`] : []),
        promptArg,
      ],
    },
    deps
  );
