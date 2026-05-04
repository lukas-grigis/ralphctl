/**
 * `linkSkillsLeaf` — install the bundled skill set for a phase into
 * `<cwd>/.claude/skills/` for the duration of an AI session phase.
 *
 * Pairs with {@link unlinkSkillsLeaf}. The chain wraps every AI-driven
 * phase (refine, plan, execute) in `link → … → unlink` so a crash
 * mid-phase never leaves stale bundled files behind.
 *
 * Phase decides which bundled folder is overlaid on top of `default/`:
 *  - `'refine'` — refine-specific skills (e.g. requirements shaping)
 *  - `'plan'`   — plan-specific skills (e.g. task decomposition)
 *  - `'exec'`   — execution-specific skills (e.g. code-edit hygiene)
 *
 * Project-authored skills under `<cwd>/.claude/skills/<name>/` always
 * win — the linker skips bundled skills whose name collides with an
 * existing project copy and never removes a directory it didn't create.
 */
import type { StorageError } from '@src/domain/errors/storage-error.ts';
import type { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { Leaf } from '@src/kernel/chain/leaf.ts';
import type { Element } from '@src/kernel/chain/element.ts';

/** Bundled-skill phase — must match `SkillsPhase` in the integration adapter. */
export type SkillsPhase = 'refine' | 'plan' | 'exec';

/**
 * Subset of {@link BundledSkillsCopier} the chain layer actually invokes.
 * Mirrors the integration port without forcing chains to import the
 * full integration interface.
 */
export interface SessionSkillsLinkerLike {
  install(sessionDir: AbsolutePath, phase: SkillsPhase): Promise<Result<void, StorageError>>;
  uninstall(sessionDir: AbsolutePath): Promise<Result<void, StorageError>>;
}

export interface LinkSkillsCtx {
  /**
   * Working directory for the AI session phase — typically a per-sprint
   * sandbox workspace stamped by an upstream workspace-build leaf.
   * Optional on the type because the workspace leaf is what populates
   * it; the leaf's input mapper throws a clear error when this is
   * missing so a misconfigured chain surfaces immediately rather than
   * silently installing skills under `cwd: undefined`.
   */
  readonly cwd?: AbsolutePath;
}

export interface LinkSkillsLeafDeps {
  readonly skillsLinker: SessionSkillsLinkerLike;
}

export interface LinkSkillsLeafOptions {
  readonly name?: string;
  readonly phase: SkillsPhase;
}

export function linkSkillsLeaf<TCtx extends LinkSkillsCtx>(
  deps: LinkSkillsLeafDeps,
  opts: LinkSkillsLeafOptions
): Element<TCtx> {
  const name = opts.name ?? 'link-skills';
  const phase = opts.phase;
  return new Leaf<TCtx, { readonly cwd: AbsolutePath }, void>(name, {
    useCase: {
      async execute(input): Promise<Result<void, StorageError>> {
        return deps.skillsLinker.install(input.cwd, phase);
      },
    },
    input: (ctx) => {
      if (!ctx.cwd) {
        throw new Error(`${name}: ctx.cwd must be set before this leaf runs`);
      }
      return { cwd: ctx.cwd };
    },
    output: (ctx) => ctx,
  });
}
