/**
 * HousekeepingView over a real tmpdir app: the scan is a dry run, `space` marks rows, `↵` deletes
 * the marked ones only after the ConfirmCard.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HousekeepingView } from '@src/application/ui/tui/views/housekeeping-view.tsx';
import { createRealFsApp, type RealFsApp } from '@tests/helpers/real-fs-app.ts';
import { holdFlowLock } from '@tests/helpers/hold-flow-lock.ts';
import type { Housekeeping } from '@src/application/flows/housekeeping/housekeeping.ts';
import { makeDoneSprint, makeDraftSprint, makeProject, projectId } from '@tests/fixtures/domain.ts';
import { ENTER, ESC, tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';

const GONE = projectId('01900000-0000-7000-8000-0000000000ff');

const exists = async (path: string): Promise<boolean> =>
  fs.stat(path).then(
    () => true,
    () => false
  );

describe('HousekeepingView', () => {
  let app: RealFsApp;
  let memoryDir: string;
  let runDir: string;

  beforeEach(async () => {
    app = await createRealFsApp();
    const { deps, paths } = app;
    await deps.projectRepo.save(makeProject());
    await deps.sprintRepo.save(makeDraftSprint({ name: 'ghost-a', projectId: GONE }));
    await deps.sprintRepo.save(makeDraftSprint({ name: 'ghost-b', projectId: GONE }));
    await deps.sprintRepo.save(makeDoneSprint());
    memoryDir = join(String(paths.memoryRoot), `${GONE}--gone`);
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(join(memoryDir, 'learnings.ndjson'), 'x');
    runDir = join(String(paths.runsRoot), 'readiness', '2026-01-01T00-00-00-000Z-aaaaaa');
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(join(runDir, 'body.txt'), 'x');
  });

  afterEach(async () => {
    await app.cleanup();
  });

  const mount = (): ReturnType<typeof renderView>['result'] =>
    renderView(<HousekeepingView />, { deps: app.deps, initial: { id: 'housekeeping' } }).result;

  it('previews every group with sizes and deletes nothing', async () => {
    const result = mount();
    await waitForViewReady(result, (f) => f.includes('Orphan sprints'));
    const frame = result.lastFrame() ?? '';
    for (const label of ['Orphan sprints', 'Orphan memory', 'Old done sprints', 'Old runs', 'ghost-a', 'reclaimable']) {
      expect(frame).toContain(label);
    }
    expect(frame).toMatch(/\d+(\.\d)? (B|KB)/);
    expect(frame).toContain('Dry run');
    expect(frame).toMatch(/0 of \d+ selected/);
    result.stdin.write(ENTER);
    await tick(40);
    expect(result.lastFrame() ?? '').toContain('nothing selected');
    result.unmount();
  });

  it('keeps each candidate on one line with its cursor and checkbox at 60 columns', async () => {
    const { result } = renderView(<HousekeepingView />, {
      deps: app.deps,
      initial: { id: 'housekeeping' },
      size: { columns: 60, rows: 24 },
    });
    await waitForViewReady(result, (f) => f.includes('Orphan sprints'));
    const lines = (result.lastFrame() ?? '').split('\n');
    const rows = lines.filter((l) => l.includes('[ ]'));
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows[0]).toContain('▸');
    // No blank spacer line between consecutive candidate rows.
    const first = lines.indexOf(rows[0] as string);
    expect(lines.slice(first, first + rows.length).every((l) => l.includes('[ ]'))).toBe(true);
    result.unmount();
  });

  it('tells orphan memory rows apart at 60 columns: slug first, natural order', async () => {
    for (const [i, n] of ['ghost-10', 'ghost-2', 'ghost-1'].entries()) {
      const dir = join(String(app.paths.memoryRoot), `01900000-0000-7000-8000-0000000000a${String(i)}--${n}`);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(join(dir, 'learnings.ndjson'), 'x');
    }
    const { result } = renderView(<HousekeepingView />, {
      deps: app.deps,
      initial: { id: 'housekeeping' },
      size: { columns: 60, rows: 40 },
    });
    await waitForViewReady(result, (f) => f.includes('Orphan memory'));
    const tails = (result.lastFrame() ?? '')
      .split('\n')
      .filter((l) => l.includes('project removed'))
      .map((l) => /(ghost-\d+)/.exec(l)?.[1])
      .filter((t) => t !== undefined);
    expect(tails).toEqual(['ghost-1', 'ghost-2', 'ghost-10']);
    result.unmount();
  });

  it('deletes one orphan sprint through ConfirmCard and leaves the other groups untouched', async () => {
    const scan = await app.deps.housekeeping.scan();
    if (!scan.ok) throw scan.error;
    const target = scan.value.orphanSprints[0]!;
    const targetDir = await app.resolveSprintDir(target.sprintId);
    const otherDir = await app.resolveSprintDir(scan.value.orphanSprints[1]!.sprintId);

    const result = mount();
    await waitForViewReady(result, (f) => f.includes('ghost-a'));
    result.stdin.write(' ');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('1 of'));
    result.stdin.write(ENTER);
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('Delete 1 item'));
    expect(await exists(targetDir)).toBe(true);
    result.stdin.write('y');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('removed 1 item'));

    expect(await exists(targetDir)).toBe(false);
    expect(await exists(otherDir)).toBe(true);
    expect(await exists(memoryDir)).toBe(true);
    expect(await exists(runDir)).toBe(true);
    result.unmount();
  });

  it('esc on the confirm keeps everything', async () => {
    const scan = await app.deps.housekeeping.scan();
    if (!scan.ok) throw scan.error;
    const targetDir = await app.resolveSprintDir(scan.value.orphanSprints[0]!.sprintId);
    const result = mount();
    await waitForViewReady(result, (f) => f.includes('ghost-a'));
    result.stdin.write(' ');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('1 of'));
    result.stdin.write(ENTER);
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('Delete 1 item'));
    result.stdin.write(ESC);
    await waitForPredicate(() => !(result.lastFrame() ?? '').includes('Delete 1 item'));
    expect(await exists(targetDir)).toBe(true);
    result.unmount();
  });

  const confirmFirstRow = async (result: ReturnType<typeof renderView>['result']): Promise<void> => {
    await waitForViewReady(result, (f) => f.includes('ghost-a'));
    result.stdin.write(' ');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('1 of'));
    result.stdin.write(ENTER);
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('Delete 1 item'));
    result.stdin.write('y');
  };

  it('shows the refusal and deletes nothing while a flow is running', async () => {
    const scan = await app.deps.housekeeping.scan();
    if (!scan.ok) throw scan.error;
    const targetDir = await app.resolveSprintDir(scan.value.orphanSprints[0]!.sprintId);
    const lock = await holdFlowLock(app.paths);
    try {
      const result = mount();
      await confirmFirstRow(result);
      await waitForPredicate(() => (result.lastFrame() ?? '').includes('A flow is running'));
      expect(await exists(targetDir)).toBe(true);
      result.unmount();
    } finally {
      await lock.release();
    }
  });

  it('keeps the list inactive until an in-flight purge resolves', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const real = app.deps.housekeeping;
    const purge = vi.fn<Housekeeping['purge']>(async (candidates) => {
      await gate;
      return real.purge(candidates);
    });
    const { result } = renderView(<HousekeepingView />, {
      deps: { ...app.deps, housekeeping: { scan: real.scan, purge } },
      initial: { id: 'housekeeping' },
    });
    await confirmFirstRow(result);
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('deleting'));

    result.stdin.write(ENTER);
    await tick(40);
    expect(result.lastFrame() ?? '').not.toContain('Delete 1 item');
    result.stdin.write(' ');
    await tick(40);
    expect(result.lastFrame() ?? '').toContain('1 of');
    expect(purge).toHaveBeenCalledTimes(1);

    const total = Number(/1 of (\d+)/.exec(result.lastFrame() ?? '')?.[1]);
    expect(total).toBeGreaterThan(1);

    finish();
    // The purge note lands before the rescan: the old list is still on screen, then the view drops to
    // loading, then the rescanned list (one row fewer) mounts. Only the last one has live input.
    await waitForPredicate(
      () => {
        const frame = result.lastFrame() ?? '';
        return frame.includes('removed 1 item') && frame.includes(`0 of ${String(total - 1)}`);
      },
      { label: 'rescanned list after the purge' }
    );
    result.stdin.write(ENTER);
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('nothing selected'), {
      label: 'ENTER reaching the re-activated list',
    });
    expect(purge).toHaveBeenCalledTimes(1);
    result.unmount();
  });
});
