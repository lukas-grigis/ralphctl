/**
 * `renderPromptToFileLeaf` — generic chain leaf that renders a
 * fully-substituted prompt and writes it to disk.
 *
 * Default path: `<sprintDir>/contexts/<flow>-<identifier>.md`. Chains
 * with a per-unit sandbox folder pass a `path` resolver that drops the
 * file directly inside the unit (e.g. `<unit-root>/prompt.md`) so the
 * sandbox is self-contained.
 *
 * Why a leaf rather than per-use-case logic:
 *  - **Inspectable.** `cat <prompt-file>` shows the exact prompt the AI
 *    saw — same harness context, signal vocabulary, task / sprint data,
 *    schemas.
 *  - **Reproducible.** Re-running the chain re-renders the file; a
 *    failed run can be re-tried without losing fidelity.
 *  - **Uniform across flows.** Every chain that spawns an AI session
 *    runs through the same render → write → handoff pattern. Adding a
 *    new flow is one factory + one leaf invocation.
 *
 * The leaf is parameterised so each chain factory wires it for its own
 * flow:
 *
 *  - `flowName`        — `'execute'` / `'evaluate'` / `'feedback'` / etc.
 *  - `identifier`      — task id / ticket id / iteration / `''` for sprint-scoped flows
 *  - `buildPrompt`     — async function that calls the right
 *                        `prompts.buildXPrompt(...)` and returns the
 *                        rendered string (already `assertFullySubstituted`-checked
 *                        inside the adapter).
 *  - `path` (optional) — custom resolver returning the absolute file
 *                        path. When set, `flowName` / `identifier` are
 *                        used only for human-readable logging.
 *
 * The leaf:
 *  1. Resolves the absolute target path (via `path` opt or the default).
 *  2. Calls `buildPrompt()` to render the prompt.
 *  3. Writes via `WriteContextFilePort`.
 *  4. Stamps the resolved path on `ctx.promptFilePath` so the AI-spawn
 *     leaf downstream picks it up.
 *
 * Skips silently when `ctx.taskBlocked === true` (used by the per-task
 * chain to short-circuit a blocked task without wasting IO).
 */
import { join } from 'node:path';

import type { StorageError } from '@src/domain/errors/storage-error.ts';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';
import type { WriteContextFilePort } from '@src/business/ports/write-context-file-port.ts';
import type { Element, KernelError } from '@src/kernel/chain/element.ts';
import { Leaf } from '@src/kernel/chain/leaf.ts';
import { resolveStoragePaths } from '@src/integration/persistence/storage-paths.ts';

/**
 * Shape of a chain context that can carry the resolved prompt-file
 * path. Every chain that uses this leaf must extend its context type
 * with `{ readonly promptFilePath?: AbsolutePath }`.
 */
export interface CtxWithPromptFilePath {
  readonly sprintId: SprintId;
  readonly promptFilePath?: AbsolutePath;
  readonly taskBlocked?: boolean;
}

export interface RenderPromptToFileOpts<TCtx extends CtxWithPromptFilePath> {
  /** Discriminator for the file basename: `<flowName>-<identifier>.md`. */
  readonly flowName: string;
  /**
   * Stable identifier for this rendering — task id, ticket id,
   * iteration counter, etc. May be empty for sprint-scoped renders
   * (the basename collapses to `<flowName>.md`).
   */
  readonly identifier: (ctx: TCtx) => string;
  /**
   * Async callback that renders the full prompt body. The adapter's
   * `assertFullySubstituted` fence runs inside the underlying
   * `buildXPrompt` method, so any leftover placeholder surfaces as a
   * `Result.error` here and aborts the chain step.
   */
  readonly buildPrompt: (ctx: TCtx) => Promise<Result<string, StorageError>>;
  /**
   * Optional predicate. When it returns `true` the leaf no-ops without
   * building the prompt or writing the file. Used by chains that have
   * a pre-spawn short-circuit (e.g. feedback's empty-input path) so
   * the chain trace stays honest while no IO fires.
   */
  readonly skip?: (ctx: TCtx) => boolean;
  /**
   * Optional override for the prompt file's absolute path. When set,
   * the leaf writes there instead of `<sprintDir>/contexts/<flow>-<id>.md`.
   * Use this when the chain has a per-unit sandbox folder so the prompt
   * lives next to the other unit artefacts.
   */
  readonly path?: (ctx: TCtx) => AbsolutePath;
}

/**
 * Build the render-prompt-to-file leaf for a flow.
 *
 * The leaf name is fixed (`render-prompt-to-file`) so every chain trace
 * carries the same step name regardless of flow — REQUIREMENTS.md
 * locks this in.
 */
export function renderPromptToFileLeaf<TCtx extends CtxWithPromptFilePath>(
  deps: { readonly writeContextFile: WriteContextFilePort },
  opts: RenderPromptToFileOpts<TCtx>
): Element<TCtx> {
  return new Leaf<TCtx, { readonly ctx: TCtx; readonly path: AbsolutePath }, AbsolutePath>('render-prompt-to-file', {
    useCase: {
      async execute(input): Promise<Result<AbsolutePath, KernelError>> {
        if (input.ctx.taskBlocked === true) {
          // Short-circuit for blocked tasks — no spawn will happen,
          // so the prompt file is wasted IO. Stamp a dummy path so
          // downstream leaves don't trip on `undefined`.
          return Result.ok(input.path);
        }
        if (opts.skip?.(input.ctx) === true) {
          // Caller-side short-circuit (e.g. empty-input feedback round).
          // The downstream AI-spawn leaf is responsible for the
          // matching guard so it doesn't try to spawn against a
          // missing file.
          return Result.ok(input.path);
        }
        const built = await opts.buildPrompt(input.ctx);
        if (!built.ok) return Result.error(built.error);
        const written = await deps.writeContextFile.write(input.path, built.value);
        if (!written.ok) return Result.error(written.error);
        return Result.ok(input.path);
      },
    },
    input: (ctx) => {
      const path = opts.path ? opts.path(ctx) : defaultPromptPath(ctx, opts);
      return { ctx, path };
    },
    output: (ctx, promptFilePath) => ({ ...ctx, promptFilePath }),
  });
}

function defaultPromptPath<TCtx extends CtxWithPromptFilePath>(
  ctx: TCtx,
  opts: RenderPromptToFileOpts<TCtx>
): AbsolutePath {
  const storagePaths = resolveStoragePaths();
  const sprintDir = storagePaths.sprintDir(ctx.sprintId);
  const id = opts.identifier(ctx);
  const basename = id.length > 0 ? `${opts.flowName}-${id}.md` : `${opts.flowName}.md`;
  return AbsolutePath.trustString(join(sprintDir, 'contexts', basename));
}
