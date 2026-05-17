/**
 * Render tests for PathPickerPrompt. Verifies the initial cwd appears in the header, the
 * `[Select this directory]` row commits the current cwd on Enter, and Esc cancels.
 *
 * Filesystem-backed tests: each `describe` block creates a tmpdir with a fixed subdirectory
 * shape so the picker has something deterministic to render.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { PathPickerPrompt } from '@src/application/ui/tui/prompts/path-picker-prompt.tsx';
import { DOWN, ENTER, ESC, tick } from '@tests/integration/application/ui/tui/_keys.ts';

describe('PathPickerPrompt', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'ralphctl-pp-'));
    await fs.mkdir(join(root, 'alpha'));
    await fs.mkdir(join(root, 'bravo'));
    await fs.mkdir(join(root, '.hidden'));
    await fs.writeFile(join(root, 'note.txt'), 'not a directory');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('renders the initial cwd and the visible directories', async () => {
    const { lastFrame, unmount } = render(
      <PathPickerPrompt message="Pick" initial={root} onSubmit={() => undefined} onCancel={() => undefined} />
    );
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain(root);
    expect(frame).toContain('alpha/');
    expect(frame).toContain('bravo/');
    expect(frame).not.toContain('.hidden');
    expect(frame).not.toContain('note.txt');
    unmount();
  });

  it('[Select this directory] commits the current cwd on Enter (cursor defaults here)', async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      <PathPickerPrompt message="Pick" initial={root} onSubmit={onSubmit} onCancel={() => undefined} />
    );
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith(root);
    unmount();
  });

  it('navigates into a subdirectory and selects it', async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      <PathPickerPrompt message="Pick" initial={root} onSubmit={onSubmit} onCancel={() => undefined} />
    );
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(ENTER);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith(join(root, 'alpha'));
    unmount();
  });

  it('Esc cancels', async () => {
    const onCancel = vi.fn();
    const { stdin, unmount } = render(
      <PathPickerPrompt message="Pick" initial={root} onSubmit={() => undefined} onCancel={onCancel} />
    );
    await tick();
    stdin.write(ESC);
    await tick(150);
    expect(onCancel).toHaveBeenCalled();
    unmount();
  });
});
