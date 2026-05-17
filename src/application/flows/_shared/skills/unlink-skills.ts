/**
 * `unlinkSkillsLeaf` — uninstall bundled skills the matching {@link linkSkillsLeaf} placed
 * into the sandbox.
 *
 * Idempotent: dispatching to an adapter that never saw an install (or has already been
 * uninstalled) is a no-op. The leaf is intended to run in the chain's success path; the
 * failure path leaves bundled skills in place. `install` is also idempotent so the next run
 * recovers cleanly — matches v1's behaviour.
 */

import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { SkillsAdapter } from '@src/integration/ai/skills/_engine/skills-port.ts';

export interface UnlinkSkillsDeps {
  readonly skillsAdapter: SkillsAdapter;
}

export interface UnlinkSkillsOptions<TCtx> {
  readonly name?: string;
  /** Same picker as the matching `linkSkillsLeaf` — ensures install/uninstall target the
   * same sandbox even when the chain has multiple AI sub-sessions per run. */
  readonly cwdPicker: (ctx: TCtx) => AbsolutePath;
}

export const unlinkSkillsLeaf = <TCtx>(deps: UnlinkSkillsDeps, opts: UnlinkSkillsOptions<TCtx>): Element<TCtx> => {
  const name = opts.name ?? 'unlink-skills';
  return leaf<TCtx, { readonly cwd: AbsolutePath }, void>(name, {
    useCase: {
      execute: async (input) => deps.skillsAdapter.uninstall(input.cwd),
    },
    input: (ctx) => ({ cwd: opts.cwdPicker(ctx) }),
    output: (ctx) => ctx,
  });
};
