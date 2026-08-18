/**
 * Regression: the read-only document overlays window by ROW COUNT, but the artifacts they read
 * are written one paragraph per line. Before the wrap fix a single long critique / progress note
 * counted as ONE line while Ink painted it across a dozen terminal rows, so:
 *
 *   - `maxOffset` stayed 0 → `useDocumentScroll` early-returned on every keystroke and the
 *     clipped tail was unreachable,
 *   - the `lines X–Y of N` footer never appeared, and
 *   - the overlay grew taller than the viewport it was supposed to fit inside.
 *
 * Both overlays get the same three assertions: the footer shows up, PgDn actually moves, and the
 * painted frame stays inside the terminal's row budget.
 *
 * ink-testing-library's stdout reports 100 columns and no rows (so `useTerminalSize` falls back
 * to 24) — the numbers below are derived from that, not hardcoded guesses.
 */

import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import React, { useEffect } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { StoragePaths } from '@src/application/bootstrap/storage-paths.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { DepsProvider } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { StorageProvider } from '@src/application/ui/tui/runtime/storage-context.tsx';
import { UiStateProvider, useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { SelectionProvider, useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { EvaluationOverlay } from '@src/application/ui/tui/components/evaluation-overlay.tsx';
import { ProgressOverlay } from '@src/application/ui/tui/components/progress-overlay.tsx';
import type { EvaluationTarget } from '@src/application/ui/tui/runtime/evaluation-target.ts';
import { PAGE_DOWN, tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';

const SPRINT_ID_STR = '0193ed2b-1234-7abc-8def-0123456789ab';
const TASK_ID = 'task-wrap-1';
const ARTIFACT = 'rounds/1/evaluator/evaluation.md';

/** ink-testing-library reports 100 columns and no rows; `useTerminalSize` floors rows at 24. */
const TERMINAL_ROWS = 24;

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

/** One unwrapped paragraph of `words` distinct tokens — the shape both artifacts are written in. */
const paragraph = (prefix: string, words: number): string =>
  Array.from({ length: words }, (_, i) => `${prefix}${String(i).padStart(3, '0')}`).join(' ');

const tmpRoots: string[] = [];
const makeTmpRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'ralphctl-overlay-wrap-'));
  tmpRoots.push(root);
  return root;
};

afterEach(async () => {
  while (tmpRoots.length > 0) {
    const root = tmpRoots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

const frameRows = (frame: string): number => frame.split('\n').length;

/* ------------------------------------------------------------------ evaluation overlay */

const evaluationTarget = (): EvaluationTarget => ({
  sprintId: parseSprintId(),
  taskId: TASK_ID,
  taskLabel: 'wrap the critique',
  attemptN: 1,
  status: 'failed',
  file: ARTIFACT,
});

const EvaluationOpener = (): React.JSX.Element | null => {
  const ui = useUiState();
  const open = ui.openEvaluation;
  useEffect(() => {
    open(evaluationTarget());
  }, [open]);
  return ui.evaluationTarget === undefined ? null : <EvaluationOverlay />;
};

const EvaluationHarness = ({ dataRoot }: { readonly dataRoot: string }): React.JSX.Element => (
  <DepsProvider value={{} as unknown as AppDeps}>
    <StorageProvider value={buildStorage(dataRoot)}>
      <UiStateProvider>
        <EvaluationOpener />
      </UiStateProvider>
    </StorageProvider>
  </DepsProvider>
);

const writeEvaluation = async (dataRoot: string, critique: string): Promise<void> => {
  const path = join(dataRoot, 'sprints', SPRINT_ID_STR, 'implement', TASK_ID, ARTIFACT);
  await fs.mkdir(dirname(path), { recursive: true });
  const body = ['# Evaluation — failed', '', '## Critique', '', critique, ''].join('\n');
  await fs.writeFile(path, body, 'utf8');
};

describe('EvaluationOverlay — wrapped rows are windowed as rows', () => {
  it('paginates and scrolls a single-paragraph critique instead of overflowing the viewport', async () => {
    const dataRoot = await makeTmpRoot();
    const critique = paragraph('crit', 200);
    await writeEvaluation(dataRoot, critique);

    const { stdin, lastFrame, unmount } = render(<EvaluationHarness dataRoot={dataRoot} />);
    await waitForPredicate(() => (lastFrame() ?? '').includes('crit000'));
    // Let the post-load render commit before typing: the scroll handler closes over the line
    // count, so a keystroke racing the first painted frame would still see the loading state's 0.
    await tick(30);

    const top = lastFrame() ?? '';
    // One logical critique line used to mean `maxOffset === 0`: no footer, no scrolling.
    expect(top).toMatch(/lines 1[–-]/);
    expect(frameRows(top)).toBeLessThanOrEqual(TERMINAL_ROWS);
    // The wrap is a reflow, not a truncation — the head of the paragraph is intact.
    expect(top).toContain('crit000 crit001');
    // The tail is off-screen until the user scrolls to it.
    expect(top).not.toContain('crit199');

    stdin.write(PAGE_DOWN);
    await waitForPredicate(() => !(lastFrame() ?? '').includes('crit000'));

    const scrolled = lastFrame() ?? '';
    expect(scrolled).not.toContain('crit000');
    expect(scrolled).toMatch(/lines \d+[–-]/);
    expect(frameRows(scrolled)).toBeLessThanOrEqual(TERMINAL_ROWS);

    unmount();
  });
});

/* -------------------------------------------------------------------- progress overlay */

const SeedSprint = (): React.JSX.Element => {
  const selection = useSelection();
  const setSprint = selection.setSprint;
  useEffect(() => {
    setSprint(parseSprintId(), 'demo-sprint');
  }, [setSprint]);
  return selection.sprintId === undefined ? <Text>SEEDING</Text> : <ProgressOverlay />;
};

const ProgressHarness = ({ dataRoot }: { readonly dataRoot: string }): React.JSX.Element => (
  <DepsProvider value={{} as unknown as AppDeps}>
    <StorageProvider value={buildStorage(dataRoot)}>
      <UiStateProvider>
        <SelectionProvider>
          <SeedSprint />
        </SelectionProvider>
      </UiStateProvider>
    </StorageProvider>
  </DepsProvider>
);

const writeProgress = async (dataRoot: string, body: string): Promise<void> => {
  const dir = join(dataRoot, 'sprints', SPRINT_ID_STR);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'progress.md'), body, 'utf8');
};

describe('ProgressOverlay — wrapped rows are windowed as rows', () => {
  it('paginates and scrolls a single-paragraph note instead of overflowing the viewport', async () => {
    const dataRoot = await makeTmpRoot();
    await writeProgress(dataRoot, ['# Progress', '', paragraph('note', 200), ''].join('\n'));

    const { stdin, lastFrame, unmount } = render(<ProgressHarness dataRoot={dataRoot} />);
    await waitForPredicate(() => (lastFrame() ?? '').includes('note000'));
    await tick(30);

    const top = lastFrame() ?? '';
    expect(top).toMatch(/lines 1[–-]/);
    expect(frameRows(top)).toBeLessThanOrEqual(TERMINAL_ROWS);
    expect(top).toContain('note000 note001');
    expect(top).not.toContain('note199');

    stdin.write(PAGE_DOWN);
    await waitForPredicate(() => !(lastFrame() ?? '').includes('note000'));

    const scrolled = lastFrame() ?? '';
    expect(scrolled).not.toContain('note000');
    expect(scrolled).toMatch(/lines \d+[–-]/);
    expect(frameRows(scrolled)).toBeLessThanOrEqual(TERMINAL_ROWS);

    unmount();
  });
});
