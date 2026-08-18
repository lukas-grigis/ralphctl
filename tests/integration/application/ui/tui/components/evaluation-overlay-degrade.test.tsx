/**
 * EvaluationOverlay — the HARD DEGRADE RULE, one test per arm.
 *
 * A `tasks.json` row can carry a stale, absent, or hostile artifact path, and a pruned workspace
 * makes a valid one unreadable. EVERY such case must render today's one-line `EvaluationLine` —
 * `eval <status> · attempt N` — plus one dim explanatory row. Never an error card: the operator
 * pressed `v` to read a verdict, and the verdict is still known even when its prose is not.
 *
 * Each test asserts BOTH halves: the verdict line is present, and no error glyph / "Could not
 * read"-style failure framing is. The read-error arm is the one exception — it is allowed to name
 * the cause — and it still leads with the verdict line, which is what this file pins.
 */

import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Box, Text, useInput } from 'ink';
import { render } from 'ink-testing-library';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { StoragePaths } from '@src/application/bootstrap/storage-paths.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { DepsProvider } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { SessionsProvider } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import type { SessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import { StorageProvider } from '@src/application/ui/tui/runtime/storage-context.tsx';
import { UiStateProvider, useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { SelectionProvider } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { RouterProvider } from '@src/application/ui/tui/runtime/router.tsx';
import { useGlobalKeys } from '@src/application/ui/tui/runtime/use-global-keys.ts';
import { EvaluationOverlay } from '@src/application/ui/tui/components/evaluation-overlay.tsx';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import type { EvaluationTarget } from '@src/application/ui/tui/runtime/evaluation-target.ts';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';

const SPRINT_ID_STR = '0193ed2b-1234-7abc-8def-0123456789ab';
const TASK_ID = 'task-eval-degrade';

const absPath = (p: string): AbsolutePath => {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error(`invalid path: ${p}`);
  return r.value;
};

const parseSprintId = (): SprintId => {
  const r = SprintId.parse(SPRINT_ID_STR);
  if (!r.ok) throw new Error('invalid SprintId fixture');
  return r.value;
};

const buildStorage = (dataRoot: string): StoragePaths => ({
  appRoot: absPath(dataRoot),
  dataRoot: absPath(dataRoot),
  configRoot: absPath(dataRoot),
  stateRoot: absPath(dataRoot),
  locksRoot: absPath(dataRoot),
  runsRoot: absPath(dataRoot),
  memoryRoot: absPath(dataRoot),
  operatorSkillsRoot: absPath(dataRoot),
  operatorAgentDefinitionsRoot: absPath(dataRoot),
});

const target = (overrides: Partial<EvaluationTarget> = {}): EvaluationTarget => ({
  sprintId: parseSprintId(),
  taskId: TASK_ID,
  taskLabel: 'legacy task',
  attemptN: 3,
  status: 'failed',
  ...overrides,
});

const emptyManager = (): SessionManager =>
  ({ list: () => [], get: () => undefined, subscribe: () => () => undefined }) as unknown as SessionManager;

const Opener = ({ evaluationTarget }: { readonly evaluationTarget: EvaluationTarget }): React.JSX.Element => {
  const ui = useUiState();
  useInput(
    (input) => {
      if (ui.modalOpen) return;
      if (input === 'v') ui.openEvaluation(evaluationTarget);
    },
    { isActive: !ui.modalOpen }
  );
  return <Text>UNDERLYING_VIEW</Text>;
};

const Harness = ({
  dataRoot,
  evaluationTarget,
}: {
  readonly dataRoot: string;
  readonly evaluationTarget: EvaluationTarget;
}): React.JSX.Element => (
  <DepsProvider value={{} as unknown as AppDeps}>
    <StorageProvider value={buildStorage(dataRoot)}>
      <SessionsProvider value={emptyManager()}>
        <UiStateProvider>
          <SelectionProvider>
            <RouterProvider initial={{ id: 'sprint-detail' }}>
              {(): React.JSX.Element => {
                const Inner = (): React.JSX.Element => {
                  const ui = useUiState();
                  useGlobalKeys({ disabled: ui.promptActive });
                  const open = ui.evaluationTarget !== undefined;
                  return (
                    <>
                      <Box display={open ? 'none' : 'flex'} flexDirection="column">
                        <Opener evaluationTarget={evaluationTarget} />
                      </Box>
                      {open && <EvaluationOverlay />}
                    </>
                  );
                };
                return <Inner />;
              }}
            </RouterProvider>
          </SelectionProvider>
        </UiStateProvider>
      </SessionsProvider>
    </StorageProvider>
  </DepsProvider>
);

const tmpRoots: string[] = [];
const makeTmpRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'ralphctl-eval-degrade-'));
  tmpRoots.push(root);
  return root;
};

afterEach(async () => {
  while (tmpRoots.length > 0) {
    const root = tmpRoots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

/** Open the overlay and return the frame once the given marker has landed. */
const openAndWaitFor = async (
  dataRoot: string,
  evaluationTarget: EvaluationTarget,
  marker: string
): Promise<{ readonly frame: string; readonly unmount: () => void }> => {
  const { stdin, lastFrame, unmount } = render(<Harness dataRoot={dataRoot} evaluationTarget={evaluationTarget} />);
  await waitForPredicate(() => (lastFrame() ?? '').includes('UNDERLYING_VIEW'));
  stdin.write('v');
  await waitForPredicate(() => (lastFrame() ?? '').includes(marker));
  return { frame: lastFrame() ?? '', unmount };
};

/** The one-line verdict every degrade arm must still render. */
const expectVerdictLine = (frame: string): void => {
  expect(frame).toContain('eval');
  expect(frame).toContain('failed');
  expect(frame).toContain('attempt 3');
};

describe('EvaluationOverlay — hard degrade rule', () => {
  it('legacy row with no recorded artifact path → verdict line + "no artifact recorded"', async () => {
    const dataRoot = await makeTmpRoot();
    const { frame, unmount } = await openAndWaitFor(dataRoot, target(), 'No evaluation artifact was recorded');
    expectVerdictLine(frame);
    expect(frame).toContain('No evaluation artifact was recorded for this attempt.');
    expect(frame).not.toContain(glyphs.cross);
    unmount();
  });

  it('recorded path pointing into a pruned workspace → verdict line + "no longer on disk"', async () => {
    const dataRoot = await makeTmpRoot();
    // The sprint dir exists (tasks.json would live there); the implement workspace was pruned.
    await fs.mkdir(join(dataRoot, 'sprints', SPRINT_ID_STR), { recursive: true });
    const { frame, unmount } = await openAndWaitFor(
      dataRoot,
      target({ file: 'rounds/4/evaluator/evaluation.md' }),
      'no longer on disk'
    );
    expectVerdictLine(frame);
    expect(frame).toContain('rounds/4/evaluator/evaluation.md');
    expect(frame).not.toContain(glyphs.cross);
    unmount();
  });

  it('sprint directory itself gone → verdict line, still no error card', async () => {
    const dataRoot = await makeTmpRoot();
    const { frame, unmount } = await openAndWaitFor(
      dataRoot,
      target({ file: 'rounds/1/evaluator/evaluation.md' }),
      'no longer on disk'
    );
    expectVerdictLine(frame);
    expect(frame).not.toContain(glyphs.cross);
    unmount();
  });

  it('path climbing out of the workspace is refused WITHOUT a disk read', async () => {
    const dataRoot = await makeTmpRoot();
    // Plant a readable file exactly where a naive join would land, so a leak would be visible.
    const escaped = join(dataRoot, 'SECRET.md');
    await fs.writeFile(escaped, 'SECRET-CONTENT\n', 'utf8');
    const { frame, unmount } = await openAndWaitFor(
      dataRoot,
      target({ file: '../../../../SECRET.md' }),
      'No evaluation artifact was recorded'
    );
    expectVerdictLine(frame);
    expect(frame).not.toContain('SECRET-CONTENT');
    unmount();
  });

  it('absolute path is refused WITHOUT a disk read', async () => {
    const dataRoot = await makeTmpRoot();
    const planted = join(dataRoot, 'ABSOLUTE.md');
    await fs.writeFile(planted, 'ABSOLUTE-CONTENT\n', 'utf8');
    const { frame, unmount } = await openAndWaitFor(
      dataRoot,
      target({ file: planted }),
      'No evaluation artifact was recorded'
    );
    expectVerdictLine(frame);
    expect(frame).not.toContain('ABSOLUTE-CONTENT');
    unmount();
  });

  it('unparseable artifact body → verdict line, raw bytes, no error card', async () => {
    const dataRoot = await makeTmpRoot();
    const relative = 'rounds/2/evaluator/evaluation.md';
    const path = join(dataRoot, 'sprints', SPRINT_ID_STR, 'implement', TASK_ID, relative);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, '<<<TRUNCATED WRITE', 'utf8');
    const { frame, unmount } = await openAndWaitFor(dataRoot, target({ file: relative }), 'TRUNCATED WRITE');
    expectVerdictLine(frame);
    expect(frame).toContain('showing the raw file');
    expect(frame).toContain('TRUNCATED WRITE');
    expect(frame).not.toContain(glyphs.cross);
    unmount();
  });
});
