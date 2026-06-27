import { describe, expect, it } from 'vitest';

import type { Element } from '@src/application/chain/element.ts';
import { createCreatePrFlow } from '@src/application/flows/create-pr/flow.ts';
import type { CreatePrDeps } from '@src/application/flows/create-pr/deps.ts';

/**
 * Topology fence for the create-pr chain. Construction-only: every leaf factory captures its deps in
 * a closure read lazily inside `execute`, never called here, so the deps cast is sound (same
 * rationale as the implement flow-shape fence). The AI sub-chain is a construction-time toggle
 * (`useAi`), not a runtime branch — so each shape is fenced independently. Fails deterministically if
 * a leaf is dropped, added, or reordered.
 */
const names = <T>(el: Element<T>): readonly string[] => [el.name, ...(el.children ?? []).flatMap((c) => names(c))];

const stubDeps = (): CreatePrDeps => ({}) as unknown as CreatePrDeps;

describe('createCreatePrFlow — chain-shape fence', () => {
  it('splices the AI authoring sub-chain ahead of the create-pr leaf when useAi is true (default)', () => {
    expect(names(createCreatePrFlow(stubDeps()))).toStrictEqual([
      'create-pr',
      'push-branch',
      'load-create-pr-context',
      'build-create-pr-unit',
      'render-prompt-to-file',
      'generate-pr-content',
      'create-pr',
    ]);
  });

  it('omits the AI authoring sub-chain when useAi is false', () => {
    expect(names(createCreatePrFlow(stubDeps(), { useAi: false }))).toStrictEqual([
      'create-pr',
      'push-branch',
      'create-pr',
    ]);
  });
});
