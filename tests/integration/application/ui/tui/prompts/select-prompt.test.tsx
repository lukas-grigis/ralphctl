/**
 * Render tests for SelectPrompt. Cursor moves with ↑/↓ and j/k; Enter submits the focused
 * option; Space does NOT submit (consistent with MultiSelectPrompt, where Space toggles);
 * g / G snap to top / bottom; Esc cancels.
 */

import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { SelectPrompt } from '@src/application/ui/tui/prompts/select-prompt.tsx';
import type { Choice } from '@src/business/interactive/prompt.ts';
import { DOWN, ENTER, ESC, tick, UP } from '@tests/integration/application/ui/tui/_keys.ts';

const options: ReadonlyArray<Choice<unknown>> = [
  { value: 'alpha', label: 'Alpha' },
  { value: 'bravo', label: 'Bravo' },
  { value: 'charlie', label: 'Charlie' },
];

describe('SelectPrompt', () => {
  it('Enter submits the first option by default', async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      <SelectPrompt message="Pick" options={options} onSubmit={onSubmit} onCancel={() => undefined} />
    );
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('alpha');
    unmount();
  });

  it('Space does NOT submit (Enter is the sole submit key)', async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      <SelectPrompt message="Pick" options={options} onSubmit={onSubmit} onCancel={() => undefined} />
    );
    stdin.write(' ');
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
    // Enter still submits the focused option.
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('alpha');
    unmount();
  });

  it('↓ then Enter submits the next option', async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      <SelectPrompt message="Pick" options={options} onSubmit={onSubmit} onCancel={() => undefined} />
    );
    stdin.write(DOWN);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('bravo');
    unmount();
  });

  it('j twice then k once lands on bravo', async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      <SelectPrompt message="Pick" options={options} onSubmit={onSubmit} onCancel={() => undefined} />
    );
    stdin.write('j');
    await tick();
    stdin.write('j');
    await tick();
    stdin.write('k');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('bravo');
    unmount();
  });

  it('G then Enter submits the last option', async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      <SelectPrompt message="Pick" options={options} onSubmit={onSubmit} onCancel={() => undefined} />
    );
    stdin.write('G');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('charlie');
    unmount();
  });

  it('renders all option labels in the initial frame', async () => {
    const { lastFrame, unmount } = render(
      <SelectPrompt message="Pick" options={options} onSubmit={() => undefined} onCancel={() => undefined} />
    );
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Alpha');
    expect(frame).toContain('Bravo');
    expect(frame).toContain('Charlie');
    unmount();
  });

  it('arrows still navigate options when the message body overflows', async () => {
    const onSubmit = vi.fn();
    const longBody = Array.from({ length: 30 }, (_, i) => `body line ${String(i + 1)}`).join('\n');
    const message = `Pick one\n\n${longBody}`;
    const { stdin, lastFrame, unmount } = render(
      <SelectPrompt message={message} options={options} onSubmit={onSubmit} onCancel={() => undefined} />
    );
    await tick();
    // ↓ should move the option cursor (not scroll the body — that's PgUp/PgDn / Ctrl+u/d only).
    stdin.write(DOWN);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('bravo');
    // Hint row should NOT be the old body-claims-arrows variant.
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('scroll body');
    expect(frame).toContain('PgUp/PgDn page');
    unmount();
  });

  it('Esc cancels', async () => {
    const onCancel = vi.fn();
    const { stdin, unmount } = render(
      <SelectPrompt message="Pick" options={options} onSubmit={() => undefined} onCancel={onCancel} />
    );
    stdin.write(UP); // no-op at top
    await tick();
    stdin.write(ESC);
    await tick(150);
    expect(onCancel).toHaveBeenCalled();
    unmount();
  });
});
