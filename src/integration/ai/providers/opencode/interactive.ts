import { dirname, join } from 'node:path';
import type { InteractiveAiProvider } from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { InteractiveProviderDeps } from '@src/integration/ai/providers/_engine/interactive-provider-deps.ts';
import { createInteractiveProvider } from '@src/integration/ai/providers/_engine/run-interactive-session.ts';
import { isOpencodeModelIdShape } from '@src/domain/value/settings-models/opencode.ts';

/**
 * The one directory grant OpenCode needs: read access to the prompt file the harness wrote.
 *
 * `OPENCODE_CONFIG_CONTENT` is MERGED into the operator's own config rather than replacing it
 * (documented precedence: remote → global → OPENCODE_CONFIG → project → .opencode →
 * OPENCODE_CONFIG_CONTENT), so their models, agents, and instructions survive the session — only a
 * conflicting `external_directory` rule is overridden.
 *
 * The grant is deliberately narrow: `*` stays denied and only the prompt file's own directory is
 * allowed, which is the closest analogue to the `--add-dir` scoping the other three CLIs get.
 * Verified against opencode-ai v1.18.15: the allowed directory reads, a sibling directory is
 * refused, and the operator's pre-existing rules remain in the merged rule set.
 *
 * Both separator spellings are granted on Windows. The rules are globs, where a backslash is
 * conventionally an escape character, and the path OpenCode tests may be normalised to forward
 * slashes before matching — a pattern that fails to match would not error, it would open a session
 * whose only instruction is a path it is not allowed to read. A key that matches nothing is inert,
 * so granting both costs nothing and removes the guess. (This is the one part of the mechanism
 * that could not be verified on the platform it matters for.)
 */
export const buildOpencodeEnv = (promptDir: string): Readonly<Record<string, string>> => ({
  OPENCODE_CONFIG_CONTENT: JSON.stringify({
    permission: {
      external_directory: {
        '*': 'deny',
        [join(promptDir, '*')]: 'allow',
        // Identical to the key above on POSIX (so it collapses to one), a second spelling on Windows.
        [`${promptDir.replaceAll('\\', '/')}/*`]: 'allow',
      },
    },
  }),
});
/**
 * Interactive `opencode` adapter. Spawns the OpenCode TUI with `stdio: 'inherit'` so the user
 * chats directly.
 *
 *   OPENCODE_CONFIG_CONTENT=<grant for dirname(promptFile)> \
 *     opencode <cwd> --model <provider/model> --prompt <pointer at promptFile>
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
 * There is no `--add-dir` FLAG, so anything outside the positional project directory is refused —
 * OpenCode auto-rejects it as `permission requested: external_directory (…)`. That matters because
 * `cwd` is a repository for ideate and memory-distill, which puts the prompt file outside it. The
 * equivalent grant is a config entry rather than a flag, so {@link buildOpencodeEnv} injects one
 * scoped to the prompt file's directory ({@link buildOpencodeEnv}), so the prompt POINTER is
 * always readable and the body never has to ride argv.
 *
 * `roots` beyond that directory are still NOT mounted — a caller's `additionalRoots` are silently
 * dropped on this adapter, which the port contract says should surface an `InvalidStateError`
 * instead. Pre-existing, and now fixable by the same mechanism; deliberately left alone here so a
 * spawn-safety fix does not quietly widen what an OpenCode session can read.
 *
 * Session ids are minted by OpenCode itself and only surface on the `run` JSON stream (not on the
 * TUI path), so `supportsSessionId` stays false and subscribers fall back to the runner's session
 * id, matching the codex adapter.
 *
 * Docs: https://opencode.ai/docs/cli/, https://opencode.ai/docs/permissions/
 */

export const createInteractiveOpencodeProvider = (deps: InteractiveProviderDeps): InteractiveAiProvider =>
  createInteractiveProvider(
    {
      providerName: 'interactive-opencode',
      defaultCommand: 'opencode',
      modelCatalogLabel: 'OpenCode',
      isKnownModel: isOpencodeModelIdShape,
      supportsSessionId: false,
      buildEnv: (input) => buildOpencodeEnv(dirname(String(input.promptFile))),
      buildArgs: (input, { promptArg }) => [String(input.cwd), '--model', input.model, '--prompt', promptArg],
    },
    deps
  );
