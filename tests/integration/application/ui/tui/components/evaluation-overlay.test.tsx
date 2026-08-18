/**
 * EvaluationOverlay — `v` opens the focused task's `evaluation.md`, `esc` / `v` closes, and the
 * body scrolls a document of any size.
 *
 * Mounts the real provider stack + the real global key handler so the test exercises production's
 * split: OPEN is view-local (a child that knows which card is focused), CLOSE is global. Disk
 * reads land in a per-test tmp dir so the empty / missing / unreadable branches stay deterministic.
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
import type { EvaluationTarget } from '@src/application/ui/tui/runtime/evaluation-target.ts';
import { ESC, PAGE_DOWN, tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';

const SPRINT_ID_STR = '0193ed2b-1234-7abc-8def-0123456789ab';
const TASK_ID = 'task-eval-1';
const ARTIFACT = 'rounds/2/evaluator/evaluation.md';

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

const artifactPath = (dataRoot: string, relative = ARTIFACT): string =>
  join(dataRoot, 'sprints', SPRINT_ID_STR, 'implement', TASK_ID, relative);

const writeArtifact = async (dataRoot: string, body: string, relative = ARTIFACT): Promise<void> => {
  const path = artifactPath(dataRoot, relative);
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, body, 'utf8');
};

const target = (overrides: Partial<EvaluationTarget> = {}): EvaluationTarget => ({
  sprintId: parseSprintId(),
  taskId: TASK_ID,
  taskLabel: 'wire the migration',
  attemptN: 2,
  status: 'failed',
  file: ARTIFACT,
  ...overrides,
});

/**
 * Stands in for the Execute Tasks panel / sprint-detail: owns `v` as a VIEW-LOCAL open, gated on
 * `modalOpen` exactly as both production surfaces are. Closing is left to the global handler.
 */
const OpenerChild = ({ evaluationTarget }: { readonly evaluationTarget: EvaluationTarget }): React.JSX.Element => {
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

const emptyManager = (): SessionManager =>
  ({ list: () => [], get: () => undefined, subscribe: () => () => undefined }) as unknown as SessionManager;

const GlobalHarness = ({ children }: { readonly children: React.ReactNode }): React.JSX.Element => {
  const ui = useUiState();
  useGlobalKeys({ disabled: ui.promptActive });
  const open = ui.evaluationTarget !== undefined;
  return (
    <>
      <Box display={open ? 'none' : 'flex'} flexDirection="column">
        {children}
      </Box>
      {open && <EvaluationOverlay />}
    </>
  );
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
              {(): React.JSX.Element => (
                <GlobalHarness>
                  <OpenerChild evaluationTarget={evaluationTarget} />
                </GlobalHarness>
              )}
            </RouterProvider>
          </SelectionProvider>
        </UiStateProvider>
      </SessionsProvider>
    </StorageProvider>
  </DepsProvider>
);

const tmpRoots: string[] = [];
const makeTmpRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'ralphctl-evaluation-overlay-'));
  tmpRoots.push(root);
  return root;
};

afterEach(async () => {
  while (tmpRoots.length > 0) {
    const root = tmpRoots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

const CANONICAL = [
  '# Evaluation — failed',
  '',
  '_2026-08-17T09:15:00.000Z_',
  '',
  '## Critique',
  '',
  'The legacy migration path is untested.',
  '',
  '## Dimensions',
  '',
  '### correctness — passed',
  '',
  'Logic matches the acceptance criteria.',
  '',
  '### tests — failed',
  '',
  'No regression test for the legacy row.',
  '',
].join('\n');

describe('EvaluationOverlay — open / close', () => {
  it('opens on `v` and renders the parsed verdict, critique and dimensions', async () => {
    const dataRoot = await makeTmpRoot();
    await writeArtifact(dataRoot, CANONICAL);
    const { stdin, lastFrame, unmount } = render(<Harness dataRoot={dataRoot} evaluationTarget={target()} />);
    await waitForPredicate(() => (lastFrame() ?? '').includes('UNDERLYING_VIEW'));

    stdin.write('v');
    await waitForPredicate(() => (lastFrame() ?? '').includes('The legacy migration path is untested.'));

    const opened = lastFrame() ?? '';
    expect(opened).toContain('Evaluation');
    expect(opened).toContain('wire the migration');
    expect(opened).toContain('attempt 2');
    expect(opened).toContain('correctness: passed');
    expect(opened).toContain('tests: failed');
    expect(opened).toContain('No regression test for the legacy row.');
    // True modal — the underlying view is hidden while it is up.
    expect(opened).not.toContain('UNDERLYING_VIEW');

    unmount();
  });

  it('closes on esc', async () => {
    const dataRoot = await makeTmpRoot();
    await writeArtifact(dataRoot, CANONICAL);
    const { stdin, lastFrame, unmount } = render(<Harness dataRoot={dataRoot} evaluationTarget={target()} />);
    await waitForPredicate(() => (lastFrame() ?? '').includes('UNDERLYING_VIEW'));
    stdin.write('v');
    await waitForPredicate(() => (lastFrame() ?? '').includes('correctness: passed'));

    stdin.write(ESC);
    await waitForPredicate(() => (lastFrame() ?? '').includes('UNDERLYING_VIEW'));
    expect(lastFrame() ?? '').not.toContain('esc · v to close');
    unmount();
  });

  it('closes on a second `v` — the same key toggles, like the progress overlay', async () => {
    const dataRoot = await makeTmpRoot();
    await writeArtifact(dataRoot, CANONICAL);
    const { stdin, lastFrame, unmount } = render(<Harness dataRoot={dataRoot} evaluationTarget={target()} />);
    await waitForPredicate(() => (lastFrame() ?? '').includes('UNDERLYING_VIEW'));
    stdin.write('v');
    await waitForPredicate(() => (lastFrame() ?? '').includes('correctness: passed'));

    stdin.write('v');
    await waitForPredicate(() => (lastFrame() ?? '').includes('UNDERLYING_VIEW'));
    expect(lastFrame() ?? '').not.toContain('correctness: passed');
    unmount();
  });
});

describe('EvaluationOverlay — empty / unreadable file', () => {
  it('renders an empty-state message when the artifact exists but is empty', async () => {
    const dataRoot = await makeTmpRoot();
    await writeArtifact(dataRoot, '   \n');
    const { stdin, lastFrame, unmount } = render(<Harness dataRoot={dataRoot} evaluationTarget={target()} />);
    await waitForPredicate(() => (lastFrame() ?? '').includes('UNDERLYING_VIEW'));
    stdin.write('v');
    await waitForPredicate(() => (lastFrame() ?? '').includes('exists but is empty'));

    const frame = lastFrame() ?? '';
    expect(frame).toContain('exists but is empty');
    // Degrade rule: the verdict itself is still shown.
    expect(frame).toContain('eval');
    expect(frame).toContain('failed');
    expect(frame).toContain('attempt 2');
    unmount();
  });

  it('surfaces the read error without an error card when the path is not a readable file', async () => {
    const dataRoot = await makeTmpRoot();
    // A directory where the artifact should be — `readFile` fails with EISDIR, which is the
    // portable stand-in for the permission-denied case (chmod is a no-op under a root CI user).
    await fs.mkdir(artifactPath(dataRoot), { recursive: true });
    const { stdin, lastFrame, unmount } = render(<Harness dataRoot={dataRoot} evaluationTarget={target()} />);
    await waitForPredicate(() => (lastFrame() ?? '').includes('UNDERLYING_VIEW'));
    stdin.write('v');
    await waitForPredicate(() => (lastFrame() ?? '').includes('Could not read the evaluation file.'));

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Could not read the evaluation file.');
    expect(frame).toContain('attempt 2');
    unmount();
  });

  it('falls back to the raw file when the content parses to nothing recognisable', async () => {
    const dataRoot = await makeTmpRoot();
    await writeArtifact(dataRoot, 'RAW-GARBAGE-LINE\nsecond raw line\n');
    const { stdin, lastFrame, unmount } = render(<Harness dataRoot={dataRoot} evaluationTarget={target()} />);
    await waitForPredicate(() => (lastFrame() ?? '').includes('UNDERLYING_VIEW'));
    stdin.write('v');
    await waitForPredicate(() => (lastFrame() ?? '').includes('RAW-GARBAGE-LINE'));

    const frame = lastFrame() ?? '';
    expect(frame).toContain('showing the raw file');
    expect(frame).toContain('RAW-GARBAGE-LINE');
    expect(frame).toContain('second raw line');
    unmount();
  });
});

describe('EvaluationOverlay — windowing', () => {
  /** 400 dimensions ⇒ ~1200 projected rows, far past any terminal height. */
  const hugeDocument = (): string => {
    const rows = ['# Evaluation — failed', '', '## Dimensions', ''];
    rows.push('### HEAD-DIMENSION — failed', '', 'first finding', '');
    for (let i = 0; i < 400; i += 1) rows.push(`### dim-${String(i).padStart(3, '0')} — passed`, '', 'ok', '');
    rows.push('### TAIL-DIMENSION — failed', '', 'last finding', '');
    return rows.join('\n');
  };

  it('bounds the frame and pages forward with PgDn', async () => {
    const dataRoot = await makeTmpRoot();
    await writeArtifact(dataRoot, hugeDocument());
    const { stdin, lastFrame, unmount } = render(<Harness dataRoot={dataRoot} evaluationTarget={target()} />);
    await waitForPredicate(() => (lastFrame() ?? '').includes('UNDERLYING_VIEW'));
    stdin.write('v');
    await waitForPredicate(() => (lastFrame() ?? '').includes('HEAD-DIMENSION'));

    const top = lastFrame() ?? '';
    expect(top).toContain('HEAD-DIMENSION');
    expect(top).not.toContain('TAIL-DIMENSION');
    expect(top).toMatch(/lines 1[–-]/);
    // A ~1200-row document must never paint more rows than the viewport plus chrome.
    expect(top.split('\n').length).toBeLessThan(40);

    stdin.write(PAGE_DOWN);
    await waitForPredicate(() => !(lastFrame() ?? '').includes('HEAD-DIMENSION'));
    expect(lastFrame() ?? '').toMatch(/lines \d+[–-]/);

    unmount();
  });

  it('shows no pagination footer for a document that fits the viewport', async () => {
    const dataRoot = await makeTmpRoot();
    await writeArtifact(dataRoot, CANONICAL);
    const { stdin, lastFrame, unmount } = render(<Harness dataRoot={dataRoot} evaluationTarget={target()} />);
    await waitForPredicate(() => (lastFrame() ?? '').includes('UNDERLYING_VIEW'));
    stdin.write('v');
    await waitForPredicate(() => (lastFrame() ?? '').includes('correctness: passed'));
    await tick(20);
    expect(lastFrame() ?? '').not.toMatch(/lines \d+[–-]/);
    unmount();
  });
});
