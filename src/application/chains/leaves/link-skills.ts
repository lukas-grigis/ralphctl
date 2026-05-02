/**
 * `linkSkillsLeaf` — sync the bundled default skills into the cache and
 * symlink them under `<cwd>/.claude/skills/<name>` for the duration of an
 * AI session phase.
 *
 * Pairs with {@link unlinkSkillsLeaf}. The chain wraps every AI-driven
 * phase (refine, plan, ideate, execute, feedback) in `link → … → unlink`
 * so a crash mid-phase never leaves stale links behind.
 *
 * The leaf is intentionally permissive about which `skills` it gets — it
 * is a lifecycle concern, not a business one. The default `[]` means
 * "create the directory but populate nothing", which is the right
 * behaviour for chains that don't ship default skills yet.
 */
import type { StorageError } from '@src/domain/errors/storage-error.ts';
import type { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { Leaf } from '@src/kernel/chain/leaf.ts';
import type { Element } from '@src/kernel/chain/element.ts';

/**
 * Subset of {@link SessionSkillsLinker} the chain layer actually invokes.
 * Mirrors the skills-linker port shape but without forcing chains to
 * import the full integration interface.
 */
export interface SessionSkillsLinkerLike {
  link(sessionDir: AbsolutePath, skills: readonly string[]): Promise<Result<void, StorageError>>;
  unlink(sessionDir: AbsolutePath): Promise<Result<void, StorageError>>;
}

export interface LinkSkillsCtx {
  readonly cwd: AbsolutePath;
}

export interface LinkSkillsLeafDeps {
  readonly skillsLinker: SessionSkillsLinkerLike;
}

export interface LinkSkillsLeafOptions {
  /** Skill names to link from `cache/skills/` into the session dir. Defaults to `[]`. */
  readonly skills?: readonly string[];
  readonly name?: string;
}

export function linkSkillsLeaf<TCtx extends LinkSkillsCtx>(
  deps: LinkSkillsLeafDeps,
  opts: LinkSkillsLeafOptions = {}
): Element<TCtx> {
  const skills = opts.skills ?? [];
  const name = opts.name ?? 'link-skills';
  return new Leaf<TCtx, { readonly cwd: AbsolutePath }, void>(name, {
    useCase: {
      async execute(input): Promise<Result<void, StorageError>> {
        return deps.skillsLinker.link(input.cwd, skills);
      },
    },
    input: (ctx) => ({ cwd: ctx.cwd }),
    output: (ctx) => ctx,
  });
}
