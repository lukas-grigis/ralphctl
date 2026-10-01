import { describe, expect, it } from 'vitest';
import { renderAtSize } from '@tests/helpers/render-at-size.tsx';
import { SprintHeaderStrip } from '@src/application/ui/tui/components/sprint-header-strip.tsx';
import { snapshotFromLoadedSprint } from '@src/application/ui/shared/state-snapshot.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { makeActiveSprint, makeDoneTask, makeProject, makeTodoTask } from '@tests/fixtures/domain.ts';

const blocked = (): Task => {
  const r = markTaskBlocked(makeTodoTask(), 'stuck', 'own');
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

// 1 done, 1 blocked, 1 ready → next steps: unblock row, then Implement.
const snapshot = () =>
  snapshotFromLoadedSprint({
    project: makeProject(),
    sprint: makeActiveSprint(),
    tasks: [makeDoneTask(), blocked(), makeTodoTask()],
  });

const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

describe('SprintHeaderStrip', () => {
  it('detail variant at 80 cols: one pipeline row, plural-correct counts, first step + "+1 more"', () => {
    const r = renderAtSize(<SprintHeaderStrip snapshot={snapshot()} variant="detail" />, { columns: 80, rows: 24 });
    const frame = r.lastFrame() ?? '';
    r.unmount();
    expect(count(frame, 'Refine')).toBe(1);
    expect(frame).toContain('1/3 done');
    expect(frame).toContain('1 blocked');
    expect(frame).not.toContain('ready');
    expect(frame).toContain('1 ticket · 3 tasks');
    expect(frame).toContain('next: unblock 1 blocked task');
    expect(frame).toContain('· +1 more');
    expect(frame).not.toContain('then');
    expect(frame).not.toContain('slug');
  });

  it('detail variant at 160 cols: every step joined with "then" plus the transitions line and slug', () => {
    const r = renderAtSize(<SprintHeaderStrip snapshot={snapshot()} variant="detail" />, { columns: 160, rows: 45 });
    const frame = r.lastFrame() ?? '';
    r.unmount();
    expect(frame).toContain('1 ready');
    expect(frame).toContain('then ◆ Implement');
    expect(frame).not.toContain('+1 more');
    expect(frame).toMatch(/planned .* ago .*→ active .* ago \(\+.*\)/);
    expect(frame).toContain('slug');
  });

  it('work variant has no next row', () => {
    const r = renderAtSize(<SprintHeaderStrip snapshot={snapshot()} variant="work" />, { columns: 120, rows: 24 });
    const frame = r.lastFrame() ?? '';
    r.unmount();
    expect(frame).not.toContain('next:');
    expect(frame).toContain('1/3 done');
  });
});
