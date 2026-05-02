/**
 * Smoke tests for the renderView + keypress + buildTuiDeps harness.
 *
 * Renders HomeView through the helper to prove the wiring works end-to-end:
 * setSharedDeps lands, the router is mounted, the view-hints provider is
 * present, and keypress translates documentary names to bytes.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { HomeView } from '@src/application/tui/views/home-view.tsx';
import { renderView } from './render-view.tsx';
import { press, keyToBytes } from './keypress.ts';

describe('renderView harness', () => {
  it('mounts a view with the deps graph wired up', async () => {
    const { lastFrame, settle, deps } = renderView(<HomeView sessionManager={null} />);
    await settle();
    expect(lastFrame()).toBeTruthy();
    expect(deps.sessionManager).toBeDefined();
    expect(deps.signalBus).toBeDefined();
  });

  it('returns a recording router whose mocks are spy-able', () => {
    const { router } = renderView(<HomeView sessionManager={null} />);

    expect(router.mocks.push).not.toHaveBeenCalled();
    expect(router.current.id).toBe('home');
  });
});

describe('keypress translation', () => {
  it('maps documentary names to byte sequences', () => {
    expect(keyToBytes('esc')).toBe('\x1B');
    expect(keyToBytes('enter')).toBe('\r');
    expect(keyToBytes('↑')).toBe('\x1B[A');
    expect(keyToBytes('↓')).toBe('\x1B[B');
    expect(keyToBytes('tab')).toBe('\t');
    expect(keyToBytes('shift+tab')).toBe('\x1B[Z');
  });

  it('passes plain letters through unchanged', () => {
    expect(keyToBytes('b')).toBe('b');
    expect(keyToBytes('?')).toBe('?');
    expect(keyToBytes('!')).toBe('!');
  });

  it('writes the canonical key for an action via press()', () => {
    const written: string[] = [];
    const fakeStdin = {
      write: (data: string) => {
        written.push(data);
      },
    };
    press(fakeStdin, 'global.back');
    press(fakeStdin, 'list.down');
    press(fakeStdin, 'list.open');
    expect(written).toStrictEqual(['\x1B', '\x1B[B', '\r']);
  });
});
