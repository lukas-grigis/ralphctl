import { describe, expect, it } from 'vitest';

import type { Element } from '@src/application/chain/element.ts';
import { createIdeateFlow, type CreateIdeateFlowOpts } from '@src/application/flows/ideate/flow.ts';
import type { IdeateDeps } from '@src/application/flows/ideate/deps.ts';

import { absolutePath, FIXED_PROJECT_ID, makeDraftSprint } from '@tests/fixtures/domain.ts';

/**
 * Topology fence for the ideate chain. Construction-only: every leaf factory captures its deps in a
 * closure read lazily inside `execute`, never called here, so the deps cast is sound (same rationale
 * as the implement flow-shape fence). Fails deterministically if a leaf is dropped, added, or
 * reordered.
 */
const names = <T>(el: Element<T>): readonly string[] => [el.name, ...(el.children ?? []).flatMap((c) => names(c))];

const stubDeps = (): IdeateDeps => ({}) as unknown as IdeateDeps;

const makeOpts = (): CreateIdeateFlowOpts => ({
  sprintId: makeDraftSprint().id,
  projectId: FIXED_PROJECT_ID,
  ideaTitle: 'an idea',
  ideaText: 'flesh it out',
  cwd: absolutePath('/repos/main'),
  providerId: 'claude-code',
  model: 'claude-opus-4-8',
  maxAttempts: 3,
  ideateRoot: absolutePath('/sprints/s1/ideate'),
});

describe('createIdeateFlow — chain-shape fence', () => {
  it('builds the exact leaf topology, in order', () => {
    expect(names(createIdeateFlow(stubDeps(), makeOpts()))).toStrictEqual([
      'ideate',
      'load-and-assert-sprint',
      'load-sprint',
      'assert-sprint-status',
      'load-project',
      'load-tasks',
      'build-ideate-unit',
      'render-prompt-to-file',
      'install-skills',
      'stamp-meta-ideate',
      'ideate-and-plan',
      'uninstall-skills',
      'transition-to-planned',
      'save-tasks',
      'save-sprint',
    ]);
  });
});
