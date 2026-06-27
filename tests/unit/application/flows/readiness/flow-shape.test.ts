import { describe, expect, it } from 'vitest';

import type { AiProvider, AiSettings } from '@src/domain/entity/settings.ts';
import type { Element } from '@src/application/chain/element.ts';
import { createReadinessFlow, type CreateReadinessFlowOpts } from '@src/application/flows/readiness/flow.ts';
import type { SetupReadinessDeps } from '@src/application/flows/readiness/deps.ts';

import { absolutePath, FIXED_PROJECT_ID } from '@tests/fixtures/domain.ts';
import { noopSkillsAdapter } from '@tests/fixtures/skills-fakes.ts';

/**
 * Topology fence for the readiness chain. Construction-only — no leaf executes — so most deps are an
 * inert cast. The two exceptions are `providerFor` / `skillsAdapterFor`, which the flow CALLS at
 * construction to bake the per-provider adapters into each tool sub-chain; they must therefore be
 * real callables (their return values are only stored, never invoked here). `opts.ai` is also read
 * eagerly (to pick a model + effort per provider), so it carries real per-flow rows. Fails
 * deterministically if a leaf is dropped, added, or reordered.
 */
const names = <T>(el: Element<T>): readonly string[] => [el.name, ...(el.children ?? []).flatMap((c) => names(c))];

const stubDeps = (): SetupReadinessDeps =>
  ({
    providerFor: () => undefined,
    skillsAdapterFor: () => noopSkillsAdapter,
    runsRoot: absolutePath('/data/runs'),
  }) as unknown as SetupReadinessDeps;

// All six per-flow rows on claude-code → `uniqueProvidersFromAi` resolves to a single provider, so
// the fan-out builds exactly one `tool-claude-code` sub-chain.
const row = { provider: 'claude-code', model: 'claude-opus-4-8' } as const;
const ai: AiSettings = {
  refine: row,
  plan: row,
  implement: { generator: row, evaluator: row },
  readiness: row,
  ideate: row,
  createPr: row,
};

const makeOpts = (providers?: readonly AiProvider[]): CreateReadinessFlowOpts => ({
  projectId: FIXED_PROJECT_ID,
  cwd: absolutePath('/repos/main'),
  ai,
  ...(providers !== undefined ? { providers } : {}),
});

describe('createReadinessFlow — chain-shape fence', () => {
  it('builds the exact leaf topology, in order, for a single-provider fan-out', () => {
    expect(names(createReadinessFlow(stubDeps(), makeOpts(['claude-code'])))).toStrictEqual([
      'readiness',
      'load-project',
      'pick-repository',
      'tool-claude-code',
      'probe-claude-code',
      'install-skills-claude-code',
      'allocate-run-dir-claude-code',
      'stamp-meta-claude-code',
      'propose-claude-code',
      'uninstall-skills-claude-code',
      'confirm-claude-code',
      'write-claude-code',
      'offer-skill-suggestions-claude-code',
      'install-readiness-skills-claude-code',
      'persist-suggested-skills',
    ]);
  });

  it('fans out one tool-<tool> sub-chain per scoped provider, framed by load/pick and the terminal persist leaf', () => {
    const top = createReadinessFlow(stubDeps(), makeOpts(['claude-code']));
    expect((top.children ?? []).map((c) => c.name)).toStrictEqual([
      'load-project',
      'pick-repository',
      'tool-claude-code',
      'persist-suggested-skills',
    ]);
  });
});
