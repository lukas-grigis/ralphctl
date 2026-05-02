/**
 * HelpOverlay tests — verify the overlay renders every binding from the
 * canonical keyboard map and dismisses cleanly on Esc / `?`.
 *
 * "Click-out" in a terminal Ink app collapses to "press the toggle key
 * outside the overlay" — there is no mouse event to fire. The closing
 * contract is therefore Esc OR `?` (the same toggle).
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { HelpOverlay } from './help-overlay.tsx';
import { KEYBOARD_MAP, getAllBindings, getKeyFor } from '@src/application/tui/keyboard-map.ts';

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function flushEscape(): Promise<void> {
  // Ink defers single-byte ESC by ~20ms to disambiguate it from the start
  // of an escape sequence. Waiting a touch longer flushes the escape.
  await new Promise((resolve) => setTimeout(resolve, 40));
  await flush();
}

describe('HelpOverlay', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders every binding from the keyboard map', () => {
    const onClose = vi.fn();
    const { lastFrame } = render(<HelpOverlay onClose={onClose} />);
    const frame = lastFrame() ?? '';

    // Every action's label must appear in the rendered overlay.
    for (const { action, binding } of getAllBindings()) {
      expect(frame, `${action} label '${binding.label}' missing from overlay`).toContain(binding.label);
    }
  });

  it('groups bindings by area with section headers', () => {
    const onClose = vi.fn();
    const { lastFrame } = render(<HelpOverlay onClose={onClose} />);
    const frame = lastFrame() ?? '';

    // A few representative section headers (uppercased by the overlay).
    expect(frame).toContain('GLOBAL');
    expect(frame).toContain('LIST VIEWS');
    expect(frame).toContain('LIVE EXECUTION');
    expect(frame).toContain('SETTINGS PANEL');
  });

  it('renders the canonical key for each binding', () => {
    const onClose = vi.fn();
    const { lastFrame } = render(<HelpOverlay onClose={onClose} />);
    const frame = lastFrame() ?? '';

    // A few representative keys.
    expect(frame).toContain('?'); // help.toggle / global.help
    expect(frame).toContain('!'); // global.doctor
    expect(frame).toContain('D'); // execute.detach
    expect(frame).toContain('X'); // runs.cancel
  });

  it('list navigation row shows ↑ / k', () => {
    const onClose = vi.fn();
    const { lastFrame } = render(<HelpOverlay onClose={onClose} />);
    const frame = lastFrame() ?? '';

    expect(frame).toContain('↑ / k');
    expect(frame).toContain('↓ / j');
  });

  it('Esc dismisses the overlay', async () => {
    const onClose = vi.fn();
    const { stdin } = render(<HelpOverlay onClose={onClose} />);
    await flush();
    stdin.write('');
    await flushEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('? dismisses the overlay (toggle close)', async () => {
    const onClose = vi.fn();
    const { stdin } = render(<HelpOverlay onClose={onClose} />);
    await flush();
    stdin.write(getKeyFor('global.help'));
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not call onClose for unrelated keys', async () => {
    const onClose = vi.fn();
    const { stdin } = render(<HelpOverlay onClose={onClose} />);
    await flush();
    stdin.write('a');
    stdin.write('b');
    await flush();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('every entry in KEYBOARD_MAP is reachable through the overlay', () => {
    // Sanity that the type-level Action union and the runtime entries match.
    const allKeys = Object.keys(KEYBOARD_MAP);
    expect(allKeys.length, 'no actions in the keyboard map').toBeGreaterThan(0);
    const onClose = vi.fn();
    const { lastFrame } = render(<HelpOverlay onClose={onClose} />);
    const frame = lastFrame() ?? '';
    for (const action of allKeys) {
      const binding = KEYBOARD_MAP[action as keyof typeof KEYBOARD_MAP];
      expect(frame).toContain(binding.label);
    }
  });

  it('full overlay snapshot — fails loudly on layout / binding drift', () => {
    const onClose = vi.fn();
    const { lastFrame } = render(<HelpOverlay onClose={onClose} />);
    expect(lastFrame()).toMatchSnapshot();
  });
});
