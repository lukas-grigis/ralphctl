import { describe, expect, it } from 'vitest';

import type { Element } from '@src/application/chain/element.ts';
import { createCloseSprintFlow } from '@src/application/flows/close-sprint/flow.ts';
import type { CloseSprintDeps } from '@src/application/flows/close-sprint/deps.ts';

/**
 * Topology fence for the close-sprint chain. Construction-only: every leaf factory closes over its
 * deps and reads them inside `execute`, so an inert deps cast is sound.
 */
const names = <T>(el: Element<T>): readonly string[] => [el.name, ...(el.children ?? []).flatMap((c) => names(c))];

const stubDeps = (
  opts: { readonly withGate?: boolean; readonly withMirror?: boolean; readonly withDistill?: boolean } = {}
): CloseSprintDeps =>
  ({
    ...(opts.withGate === true ? { blockedTasksGate: { taskRepo: {}, interactive: {} } } : {}),
    ...(opts.withMirror === true ? { memoryMirror: { writeFile: {}, memoryRoot: '/m', projectId: 'p' } } : {}),
    ...(opts.withDistill === true ? { distill: { deps: {}, opts: {} } } : {}),
  }) as unknown as CloseSprintDeps;

describe('createCloseSprintFlow — chain-topology fence', () => {
  it('runs the whole chain under the sprint-dir lock implement and review hold', () => {
    expect(names(createCloseSprintFlow(stubDeps()))).toStrictEqual([
      'with-repo-lock(close-sprint)',
      'close-sprint',
      'load-and-assert-sprint',
      'load-sprint',
      'assert-sprint-status',
      'transition-sprint-to-done',
      'progress-journal-close',
    ]);
  });

  it('splices the blocked-task gate, mirror refresh and distill step before the done transition', () => {
    expect(
      names(createCloseSprintFlow(stubDeps({ withGate: true, withMirror: true, withDistill: true })))
    ).toStrictEqual([
      'with-repo-lock(close-sprint)',
      'close-sprint',
      'load-and-assert-sprint',
      'load-sprint',
      'assert-sprint-status',
      'load-tasks',
      'confirm-blocked-tasks-gate',
      'confirm-blocked-tasks',
      'refresh-memory-mirror',
      'distill-learnings-step',
      'transition-sprint-to-done',
      'progress-journal-close',
    ]);
  });
});
