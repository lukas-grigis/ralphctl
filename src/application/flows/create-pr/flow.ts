import type { Element } from '@src/application/chain/element.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';

import type { CreatePrCtx } from '@src/application/flows/create-pr/ctx.ts';
import type { CreatePrDeps } from '@src/application/flows/create-pr/deps.ts';
import { createPushBranchLeaf } from '@src/application/flows/create-pr/leaves/push-branch-leaf.ts';
import { createCreatePrLeaf } from '@src/application/flows/create-pr/leaves/create-pr-leaf.ts';

/**
 * Build the create-pr chain.
 *
 *   sequential('create-pr', [
 *     push-branch,   // git push -u origin <sprint-branch>
 *     create-pr,     // gh pr create / glab mr create + persist URL
 *   ])
 *
 * Composing as a sequential leaves an obvious seam for a future AI-content leaf to slot in
 * between the two (or in front, before push, depending on where it lands). The push step
 * exists because non-TTY spawns of `gh` / `glab` can't prompt the user to publish a
 * remote-missing head — the harness has to do it.
 */
export const createCreatePrFlow = (deps: CreatePrDeps): Element<CreatePrCtx> =>
  sequential<CreatePrCtx>('create-pr', [createPushBranchLeaf(deps), createCreatePrLeaf(deps)]);
