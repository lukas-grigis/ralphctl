/**
 * `unlinkSkillsLeaf` — `rm -rf` the bundled-skills tree installed by
 * {@link linkSkillsLeaf}. Idempotent: a missing tree is a no-op.
 */
import type { StorageError } from '@src/domain/errors/storage-error.ts';
import type { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { Leaf } from '@src/kernel/chain/leaf.ts';
import type { Element } from '@src/kernel/chain/element.ts';
import type { LinkSkillsCtx, LinkSkillsLeafDeps } from './link-skills.ts';

export function unlinkSkillsLeaf<TCtx extends LinkSkillsCtx>(
  deps: LinkSkillsLeafDeps,
  opts: { readonly name?: string } = {}
): Element<TCtx> {
  const name = opts.name ?? 'unlink-skills';
  return new Leaf<TCtx, { readonly cwd: AbsolutePath }, void>(name, {
    useCase: {
      async execute(input): Promise<Result<void, StorageError>> {
        return deps.skillsLinker.uninstall(input.cwd);
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
