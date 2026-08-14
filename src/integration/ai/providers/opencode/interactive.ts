import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { InteractiveAiProvider } from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { InteractiveProviderDeps } from '@src/integration/ai/providers/_engine/interactive-provider-deps.ts';
import { createInteractiveProvider } from '@src/integration/ai/providers/_engine/run-interactive-session.ts';
import { isOpencodeModelIdShape } from '@src/domain/value/settings-models/opencode.ts';

const PROVIDER_NAME = 'interactive-opencode';

/**
 * Glob syntax inside a directory path. OpenCode expresses directory grants as glob PATTERNS, so a
 * path carrying one of these cannot be turned into a key that means "exactly this directory" — it
 * would match more or less than the caller asked for, and a pattern that matches nothing does not
 * error, it opens a session that cannot read the root. Refusing is the port's documented answer.
 */
const GLOB_METACHARS = /[*?[\]{}]/;

/**
 * Directory grants OpenCode needs, as an `OPENCODE_CONFIG_CONTENT` overlay.
 *
 * `OPENCODE_CONFIG_CONTENT` is MERGED into the operator's own config rather than replacing it
 * (documented precedence: remote → global → OPENCODE_CONFIG → project → .opencode →
 * OPENCODE_CONFIG_CONTENT), so their models, agents, and instructions survive the session — only a
 * conflicting `external_directory` rule is overridden.
 *
 * Every root the engine folded is granted and nothing else: `*` stays denied, which keeps this the
 * closest analogue to the `--add-dir` scoping the other three CLIs get. The narrower
 * prompt-directory-only grant this replaced was a spawn-safety fix that left the port contract
 * broken — a caller's `additionalRoots` were dropped without a word (#278), which the port says
 * MUST be an `InvalidStateError` instead.
 *
 * Four keys per root, two spellings × two depths:
 *   - both separator spellings, because the rules are globs (backslash is conventionally an escape
 *     character) and the path OpenCode tests may be normalised to forward slashes before matching;
 *   - both `*` and `**`, because a root is a repository: `*` reaches a file sitting directly in it
 *     (which is all the prompt-pointer grant ever had to do), `**` reaches anything nested.
 * A key that matches nothing is inert, so emitting all four costs nothing and removes two guesses.
 * `<promptDir>/*` is the one spelling verified against a live CLI (opencode-ai v1.18.15: the
 * allowed directory reads, a sibling is refused, operator rules survive the merge); `<root>/**` is
 * the spelling OpenCode's own docs name for precise scoping and still wants a live smoke run.
 */
export const buildOpencodeEnv = (
  roots: readonly string[]
): Result<Readonly<Record<string, string>>, InvalidStateError> => {
  const rules: Record<string, string> = { '*': 'deny' };
  for (const root of roots) {
    if (GLOB_METACHARS.test(root)) {
      return Result.error(
        new InvalidStateError({
          entity: PROVIDER_NAME,
          currentState: 'unexpressible-root',
          attemptedAction: 'grant directory access',
          message: `${PROVIDER_NAME}: cannot grant access to '${root}' — OpenCode expresses directory grants as glob patterns, and a path containing one of * ? [ ] { } cannot be written as a pattern matching exactly that directory`,
          hint: 'move the repository to a path without glob metacharacters, or run this flow on a provider with a --add-dir flag (claude / codex / copilot)',
        })
      );
    }
    const posix = root.replaceAll('\\', '/');
    for (const key of [join(root, '*'), join(root, '**'), `${posix}/*`, `${posix}/**`]) {
      rules[key] = 'allow';
    }
  }
  return Result.ok({
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { external_directory: rules } }),
  });
};
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
 * `cwd` is a repository for ideate and memory-distill, which puts the prompt file outside it, and
 * because plan / refine mount every repository on a multi-repo project. The equivalent grant is a
 * config entry rather than a flag, so {@link buildOpencodeEnv} injects one covering EVERY root the
 * engine folded — `cwd`, the caller's `additionalRoots`, and the prompt / output directories — so
 * the prompt POINTER is always readable, the body never has to ride argv, and a caller's extra
 * repositories are actually navigable.
 *
 * A root that cannot be expressed as a glob key is refused with `InvalidStateError` and nothing is
 * spawned, per the port's `additionalRoots` contract. Silently granting less is the failure mode
 * that motivated the contract: OpenCode does not error on a pattern that matches nothing, it just
 * opens a session that cannot read the directory.
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
      buildEnv: (_input, { roots }) => buildOpencodeEnv(roots),
      buildArgs: (input, { promptArg }) => [String(input.cwd), '--model', input.model, '--prompt', promptArg],
    },
    deps
  );
