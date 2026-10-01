import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { TaskMinimap } from '@src/application/ui/tui/components/task-minimap.tsx';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import { makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';

describe('TaskMinimap interrupted state', () => {
  const task = makeInProgressTaskWithRunningAttempt();

  it('says "interrupted", with the warning glyph, for an in-progress task whose run died', () => {
    const { lastFrame, unmount } = render(
      <TaskMinimap tasks={[task]} visibleRows={5} width={50} interruptedIds={new Set([task.id])} />
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('interrupted');
    expect(frame).toContain(glyphs.warningGlyph);
    expect(frame).not.toContain('running');
    unmount();
  });

  it('keeps "running" for an in-progress task nobody has flagged', () => {
    const { lastFrame, unmount } = render(<TaskMinimap tasks={[task]} visibleRows={5} width={50} />);
    expect(lastFrame()).toContain('running');
    expect(lastFrame()).not.toContain('interrupted');
    unmount();
  });

  it('says "stopped", not "running", for an in-progress task whose last attempt was stopped', () => {
    const { lastFrame, unmount } = render(
      <TaskMinimap tasks={[task]} visibleRows={5} width={50} stoppedIds={new Set([task.id])} />
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('stopped');
    expect(frame).toContain(glyphs.warningGlyph);
    expect(frame).not.toContain('running');
    expect(frame).not.toContain('interrupted');
    unmount();
  });
});
