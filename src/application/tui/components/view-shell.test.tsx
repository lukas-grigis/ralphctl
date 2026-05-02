import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';

// Pin the banner quote so snapshots are stable across runs — STABLE_QUOTE
// in banner.tsx is selected at module load via getRandomQuote(), which
// would otherwise reroll on every test run and rot the captured frames.
vi.mock('../../../integration/ui/theme/theme.ts', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getRandomQuote: () => 'stable test quote' };
});

import { ViewShell } from './view-shell.tsx';
import { RouterProvider } from '@src/application/tui/views/router-context.ts';
import { ViewHintsProvider, useViewHints } from '@src/application/tui/views/view-hints-context.tsx';
import { KeyboardHints } from './keyboard-hints.tsx';

function makeRouter() {
  return {
    current: { id: 'settings' as const },
    stack: [{ id: 'home' as const }, { id: 'settings' as const }],
    push: vi.fn(),
    pop: vi.fn(),
    replace: vi.fn(),
    reset: vi.fn(),
  };
}

describe('ViewShell', () => {
  it('renders the section stamp header with title', () => {
    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <ViewShell title="Test View">
            <Text>body content</Text>
          </ViewShell>
        </ViewHintsProvider>
      </RouterProvider>
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('TEST VIEW');
    expect(frame).toContain('body content');
  });

  it('renders children without header when bare=true', () => {
    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <ViewShell bare>
            <Text>bare body</Text>
          </ViewShell>
        </ViewHintsProvider>
      </RouterProvider>
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('bare body');
    // No section stamp badge in bare mode
    expect(frame).not.toContain('▣');
  });

  it('renders keyboard hints from useViewHints', async () => {
    const router = makeRouter();
    function ViewWithHints(): React.JSX.Element {
      useViewHints([{ key: 'x', action: 'xray' }]);
      return <Text>body</Text>;
    }
    // Render the hints provider + a component publishing hints + the hints component directly.
    // useViewHints uses useEffect which fires after render — give React a tick to apply.
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <ViewWithHints />
          <KeyboardHints />
        </ViewHintsProvider>
      </RouterProvider>
    );
    // Wait for effects to flush
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain('xray');
  });

  it('renders section stamp with ▣ glyph', () => {
    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <ViewShell title="Create Sprint">
            <Text>form</Text>
          </ViewShell>
        </ViewHintsProvider>
      </RouterProvider>
    );
    expect(lastFrame()).toContain('▣');
    expect(lastFrame()).toContain('CREATE SPRINT');
  });

  describe('snapshots', () => {
    it('titled shell with body', () => {
      const router = makeRouter();
      const { lastFrame } = render(
        <RouterProvider value={router}>
          <ViewHintsProvider>
            <ViewShell title="Settings">
              <Text>two rows below</Text>
            </ViewShell>
          </ViewHintsProvider>
        </RouterProvider>
      );
      expect(lastFrame()).toMatchSnapshot();
    });

    it('bare shell — no header', () => {
      const router = makeRouter();
      const { lastFrame } = render(
        <RouterProvider value={router}>
          <ViewHintsProvider>
            <ViewShell bare>
              <Text>just body</Text>
            </ViewShell>
          </ViewHintsProvider>
        </RouterProvider>
      );
      expect(lastFrame()).toMatchSnapshot();
    });
  });
});
