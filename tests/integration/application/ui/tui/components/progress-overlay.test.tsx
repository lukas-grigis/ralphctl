/**
 * ProgressOverlay — `g` opens, `esc` closes, scrolls through the on-disk progress.md.
 *
 * Mounts the App layout the same way production does (Layout + Global keys + selection +
 * storage) so the test exercises the real `g` → toggle wiring, not a synthetic one. Disk reads
 * land in a tmp dir per test so the empty-file / long-file branches stay deterministic.
 */

import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { SelectionProvider, useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { RouterProvider } from '@src/application/ui/tui/runtime/router.tsx';
import { useGlobalKeys } from '@src/application/ui/tui/runtime/use-global-keys.ts';
import { ProgressOverlay } from '@src/application/ui/tui/components/progress-overlay.tsx';
import { ESC, tick, waitFor } from '@tests/integration/application/ui/tui/_keys.ts';

const SPRINT_ID_STR = '0193ed2b-1234-7abc-8def-0123456789ab';

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
});

const writeProgressFile = async (dataRoot: string, body: string): Promise<void> => {
  const sprintDir = join(dataRoot, 'sprints', SPRINT_ID_STR);
  await fs.mkdir(sprintDir, { recursive: true });
  await fs.writeFile(join(sprintDir, 'progress.md'), body, 'utf8');
};

const SeedSelection = ({
  withSprint,
  withFocusedRun,
}: {
  readonly withSprint: boolean;
  readonly withFocusedRun?: boolean | undefined;
}): React.JSX.Element => {
  const selection = useSelection();
  const ui = useUiState();
  const setSprintRef = React.useRef(selection.setSprint);
  setSprintRef.current = selection.setSprint;
  const setFocusedRunRef = React.useRef(ui.setFocusedRunContext);
  setFocusedRunRef.current = ui.setFocusedRunContext;
  React.useEffect(() => {
    if (withSprint) {
      setSprintRef.current(parseSprintId(), 'demo-sprint');
    }
    // Pin a run's sprint context with the GLOBAL selection left cleared — exercises the gate
    // that resolves `focusedRunSprintId ?? selection.sprintId`.
    if (withFocusedRun === true) {
      setFocusedRunRef.current({ projectLabel: undefined, sprintId: parseSprintId(), sprintLabel: 'pinned-run' });
    }
  }, [withSprint, withFocusedRun]);

  // Render a SEEDED sentinel once the effect has committed its selection value.
  // Tests wait for this sentinel instead of a fixed-tick sleep so the `g` keypress that follows
  // always fires AFTER the selection state is live — eliminating the flake profile where the
  // effect lands after the fixed tick and `g` becomes a silent no-op.
  const seeded = withSprint ? selection.sprintId !== undefined : ui.focusedRunSprintId !== undefined;
  if (!seeded) return <></>;
  return <Text>SEEDED</Text>;
};

const GlobalHarness = ({ children }: { readonly children: React.ReactNode }): React.JSX.Element => {
  const ui = useUiState();
  useGlobalKeys({ disabled: ui.promptActive });
  // Mirror the App.tsx Layout strategy: keep children mounted (display:none when overlay is open)
  // so list cursors, expanded cards, and scroll offsets are preserved across open/close cycles.
  return (
    <>
      <Box display={ui.progressOpen ? 'none' : 'flex'} flexDirection="column">
        {children}
      </Box>
      {ui.progressOpen && <ProgressOverlay />}
    </>
  );
};

interface HarnessOptions {
  readonly dataRoot: string;
  readonly withSprint: boolean;
  readonly withFocusedRun?: boolean | undefined;
}

/** Empty session manager — useGlobalKeys now reads it, but these tests exercise no running flows. */
const emptyManager = (): SessionManager =>
  ({ list: () => [], get: () => undefined, subscribe: () => () => undefined }) as unknown as SessionManager;

const Harness = ({ dataRoot, withSprint, withFocusedRun }: HarnessOptions): React.JSX.Element => {
  const deps = {} as unknown as AppDeps;
  return (
    <DepsProvider value={deps}>
      <StorageProvider value={buildStorage(dataRoot)}>
        <SessionsProvider value={emptyManager()}>
          <UiStateProvider>
            <SelectionProvider>
              <SeedSelection withSprint={withSprint} withFocusedRun={withFocusedRun} />
              <RouterProvider initial={{ id: withSprint ? 'sprint-detail' : 'home' }}>
                {(): React.JSX.Element => (
                  <GlobalHarness>
                    <Text>UNDERLYING_VIEW</Text>
                  </GlobalHarness>
                )}
              </RouterProvider>
            </SelectionProvider>
          </UiStateProvider>
        </SessionsProvider>
      </StorageProvider>
    </DepsProvider>
  );
};

const tmpRoots: string[] = [];
const makeTmpRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'ralphctl-progress-overlay-'));
  tmpRoots.push(root);
  return root;
};

afterEach(async () => {
  // Clean up tmp directories created during the test.
  while (tmpRoots.length > 0) {
    const root = tmpRoots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

describe('ProgressOverlay — open / close', () => {
  it('opens on `g` when a sprint is selected and closes on esc', async () => {
    const dataRoot = await makeTmpRoot();
    await writeProgressFile(dataRoot, '# Progress\n\nFirst line of activity.');
    const { stdin, lastFrame, unmount } = render(<Harness dataRoot={dataRoot} withSprint={true} />);
    // Wait until the SeedSelection sentinel confirms the sprint selection effect committed.
    // Replaces the old `tick(50)` which raced the effect under full-suite load.
    await waitFor(() => (lastFrame() ?? '').includes('SEEDED'));

    expect(lastFrame() ?? '').toContain('UNDERLYING_VIEW');

    stdin.write('g');
    // The overlay reads progress.md asynchronously; wait for the content to land rather than a
    // fixed tick, which races the disk read under load (caught '⠋ Loading…' on a busy box).
    await waitFor(() => (lastFrame() ?? '').includes('First line of activity.'));
    const opened = lastFrame() ?? '';
    expect(opened).toContain('Progress');
    expect(opened).toContain('demo-sprint');
    expect(opened).toContain('First line of activity.');
    expect(opened).not.toContain('UNDERLYING_VIEW');

    stdin.write(ESC);
    await waitFor(() => (lastFrame() ?? '').includes('UNDERLYING_VIEW'));
    expect(lastFrame() ?? '').toContain('UNDERLYING_VIEW');

    unmount();
  });

  it('`g` is a no-op on Home (no sprint loaded)', async () => {
    const dataRoot = await makeTmpRoot();
    const { stdin, lastFrame, unmount } = render(<Harness dataRoot={dataRoot} withSprint={false} />);
    await waitFor(() => (lastFrame() ?? '').includes('UNDERLYING_VIEW'));
    stdin.write('g');
    await tick(30);
    // No overlay — underlying view still showing, no "Progress" title.
    const frame = lastFrame() ?? '';
    expect(frame).toContain('UNDERLYING_VIEW');
    expect(frame).not.toContain('esc · g to close');
    unmount();
  });

  it('`g` opens on a pinned run when the global selection is cleared', async () => {
    // Regression: the open-gate keyed on `selection.sprintId` only, while the overlay resolves
    // `focusedRunSprintId ?? selection.sprintId`. Watching a run whose sprint is pinned (but the
    // global selection cleared) made `g` a silent no-op. The widened gate opens onto the pin.
    const dataRoot = await makeTmpRoot();
    await writeProgressFile(dataRoot, '# Progress\n\nPinned run activity.');
    const { stdin, lastFrame, unmount } = render(
      <Harness dataRoot={dataRoot} withSprint={false} withFocusedRun={true} />
    );
    // Wait until the SeedSelection sentinel confirms the focused-run pin effect committed.
    await waitFor(() => (lastFrame() ?? '').includes('SEEDED'));

    stdin.write('g');
    await waitFor(() => (lastFrame() ?? '').includes('Pinned run activity.'));
    const opened = lastFrame() ?? '';
    expect(opened).toContain('Progress');
    expect(opened).toContain('pinned-run');
    expect(opened).toContain('Pinned run activity.');
    expect(opened).not.toContain('UNDERLYING_VIEW');
    unmount();
  });
});

describe('ProgressOverlay — missing / empty file', () => {
  it('renders a friendly message when progress.md does not exist', async () => {
    const dataRoot = await makeTmpRoot();
    // No file written — overlay should NOT crash.
    const { stdin, lastFrame, unmount } = render(<Harness dataRoot={dataRoot} withSprint={true} />);
    // Wait for the SEEDED sentinel before pressing 'g' so the effect has committed.
    await waitFor(() => (lastFrame() ?? '').includes('SEEDED'));
    stdin.write('g');
    await waitFor(() => (lastFrame() ?? '').includes('No progress file yet')); // disk read + state flush

    const frame = lastFrame() ?? '';
    expect(frame).toContain('No progress file yet');
    expect(frame).not.toContain('Could not read');
    unmount();
  });

  it('renders an empty-state message when progress.md exists but is empty', async () => {
    const dataRoot = await makeTmpRoot();
    await writeProgressFile(dataRoot, '');
    const { stdin, lastFrame, unmount } = render(<Harness dataRoot={dataRoot} withSprint={true} />);
    // Wait for the SEEDED sentinel before pressing 'g' so the effect has committed.
    await waitFor(() => (lastFrame() ?? '').includes('SEEDED'));
    stdin.write('g');
    await waitFor(() => (lastFrame() ?? '').includes('exists but is empty'));

    expect(lastFrame() ?? '').toContain('exists but is empty');
    unmount();
  });
});

describe('ProgressOverlay — scrolling', () => {
  /**
   * Build a file with enough lines that body-rows < line-count under our default 24-row test
   * terminal. CHROME_ROWS=10 + MIN_BODY_ROWS=6 means the body is ~14 rows on a 24-row terminal;
   * we generate 60 lines to guarantee scroll range, and we tag the head + tail lines so the
   * test can assert the visible window without depending on the exact bodyRows count.
   */
  const buildLongFile = (): string => {
    const head = 'HEAD-LINE';
    const tail = 'TAIL-LINE';
    const middle = Array.from({ length: 58 }, (_, i) => `line-${String(i + 1).padStart(2, '0')}`);
    return [head, ...middle, tail].join('\n');
  };

  it('PgDn scrolls forward, PgUp scrolls back, bounds clamp', async () => {
    const dataRoot = await makeTmpRoot();
    await writeProgressFile(dataRoot, buildLongFile());
    const { stdin, lastFrame, unmount } = render(<Harness dataRoot={dataRoot} withSprint={true} />);
    // Wait for the SEEDED sentinel before pressing 'g' so the effect has committed.
    await waitFor(() => (lastFrame() ?? '').includes('SEEDED'));
    stdin.write('g');
    await waitFor(() => (lastFrame() ?? '').includes('HEAD-LINE'));

    // Initial: top of file visible, tail not.
    const top = lastFrame() ?? '';
    expect(top).toContain('HEAD-LINE');
    expect(top).not.toContain('TAIL-LINE');
    // The pagination footer should be visible because the file is taller than the viewport.
    expect(top).toMatch(/lines 1[–-]/);

    // PgDn enough times that we run off the bottom and clamp. Six PgDns should be more than
    // enough on any sane terminal size, and clamping guarantees we land at the bottom.
    for (let i = 0; i < 6; i += 1) {
      stdin.write('\x1b[6~'); // VT220 PgDn — ink maps this to key.pageDown
      // small tick between presses so state updates settle individually
      // (also avoids Ink's escape-sequence disambiguation timeout race)
      await tick(15);
    }
    // After the PgDn loop, use a condition-based wait instead of a fixed tick so slow state
    // flushes under full-suite load cannot fail the clamp assertion.
    await waitFor(() => (lastFrame() ?? '').includes('TAIL-LINE'));
    const bottom = lastFrame() ?? '';
    expect(bottom).toContain('TAIL-LINE');
    // Bounds clamp — the bottom frame is stable across additional PgDns.
    stdin.write('\x1b[6~');
    await waitFor(() => (lastFrame() ?? '').includes('TAIL-LINE'));
    const stillBottom = lastFrame() ?? '';
    expect(stillBottom).toContain('TAIL-LINE');

    // PgUp returns toward the top.
    for (let i = 0; i < 6; i += 1) {
      stdin.write('\x1b[5~'); // VT220 PgUp — ink maps this to key.pageUp
      await tick(15);
    }
    // Same pattern: condition-based wait after the PgUp loop.
    await waitFor(() => (lastFrame() ?? '').includes('HEAD-LINE'));
    const back = lastFrame() ?? '';
    expect(back).toContain('HEAD-LINE');
    // PgUp at the top clamps — one more press is a no-op.
    stdin.write('\x1b[5~');
    await waitFor(() => (lastFrame() ?? '').includes('HEAD-LINE'));
    expect(lastFrame() ?? '').toContain('HEAD-LINE');

    unmount();
  });
});

/**
 * Cursor-preservation tests — the key behavioural contract of the mount-preserving overlay
 * design. Children remain mounted (display:none) while the overlay is open so list cursors
 * and other view state survive open/close cycles intact.
 */

/**
 * A minimal child that tracks a list cursor with j/k and surfaces "CURSOR:<n>" in its output.
 * Uses useInput gated on `ui.modalOpen` (the unified modal flag) so pressing j while the
 * overlay is open is a no-op — the hidden view stays inert.
 */
const CursorChild = (): React.JSX.Element => {
  const ui = useUiState();
  const ITEMS = 5;
  const [cursor, setCursor] = React.useState(0);
  useInput(
    (input) => {
      if (ui.modalOpen) return;
      if (input === 'j') setCursor((c) => Math.min(ITEMS - 1, c + 1));
      if (input === 'k') setCursor((c) => Math.max(0, c - 1));
    },
    { isActive: !ui.modalOpen }
  );
  return <Text>CURSOR:{String(cursor)}</Text>;
};

const HarnessWithCursor = ({ dataRoot }: { readonly dataRoot: string }): React.JSX.Element => {
  const deps = {} as unknown as AppDeps;
  return (
    <DepsProvider value={deps}>
      <StorageProvider value={buildStorage(dataRoot)}>
        <SessionsProvider value={emptyManager()}>
          <UiStateProvider>
            <SelectionProvider>
              <SeedSelection withSprint={true} />
              <RouterProvider initial={{ id: 'sprint-detail' }}>
                {(): React.JSX.Element => (
                  <GlobalHarness>
                    <CursorChild />
                  </GlobalHarness>
                )}
              </RouterProvider>
            </SelectionProvider>
          </UiStateProvider>
        </SessionsProvider>
      </StorageProvider>
    </DepsProvider>
  );
};

describe('ProgressOverlay — cursor preservation (mounted children)', () => {
  it('list cursor is unchanged after open + close cycle', async () => {
    const dataRoot = await makeTmpRoot();
    await writeProgressFile(dataRoot, '# Progress\n\nSome content.');
    const { stdin, lastFrame, unmount } = render(<HarnessWithCursor dataRoot={dataRoot} />);
    // Wait for SEEDED sentinel before interacting.
    await waitFor(() => (lastFrame() ?? '').includes('SEEDED'));

    // Initial cursor position.
    await waitFor(() => (lastFrame() ?? '').includes('CURSOR:0'));

    // Move the cursor down twice (using 'j' — the CursorChild handles input === 'j').
    stdin.write('j');
    await waitFor(() => (lastFrame() ?? '').includes('CURSOR:1'));
    stdin.write('j');
    await waitFor(() => (lastFrame() ?? '').includes('CURSOR:2'));

    // Open the overlay — underlying view should be hidden (display:none in Ink output).
    stdin.write('g');
    await waitFor(() => (lastFrame() ?? '').includes('Some content.'));
    expect(lastFrame() ?? '').not.toContain('CURSOR:');

    // Close the overlay — cursor must still be at 2 (view was mounted, not remounted).
    stdin.write(ESC);
    await waitFor(() => (lastFrame() ?? '').includes('CURSOR:'));
    expect(lastFrame() ?? '').toContain('CURSOR:2');

    unmount();
  });

  it('keystrokes while the overlay is open do not move the hidden view cursor', async () => {
    const dataRoot = await makeTmpRoot();
    await writeProgressFile(dataRoot, '# Progress\n\nSome content.');
    const { stdin, lastFrame, unmount } = render(<HarnessWithCursor dataRoot={dataRoot} />);
    await waitFor(() => (lastFrame() ?? '').includes('SEEDED'));
    await waitFor(() => (lastFrame() ?? '').includes('CURSOR:0'));

    // Open the overlay.
    stdin.write('g');
    await waitFor(() => (lastFrame() ?? '').includes('Some content.'));

    // 'j' is a list-navigation key; the hidden view gates on ui.modalOpen so it must ignore it.
    stdin.write('j');
    await tick(50);

    // Close the overlay — cursor should still be at 0.
    stdin.write(ESC);
    await waitFor(() => (lastFrame() ?? '').includes('CURSOR:'));
    expect(lastFrame() ?? '').toContain('CURSOR:0');

    unmount();
  });
});
