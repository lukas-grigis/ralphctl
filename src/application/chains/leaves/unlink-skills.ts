/**
 * `unlinkSkillsLeaf` — tear down the symlinks created by
 * {@link linkSkillsLeaf} after an AI session phase exits.
 *
 * Idempotent — a second call is a no-op. Non-symlink entries the user
 * placed under `.claude/skills/` are preserved.
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
        return deps.skillsLinker.unlink(input.cwd);
      },
    },
    input: (ctx) => ({ cwd: ctx.cwd }),
    output: (ctx) => ctx,
  });
}
