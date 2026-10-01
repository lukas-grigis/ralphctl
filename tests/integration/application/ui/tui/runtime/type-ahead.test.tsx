/**
 * Type-ahead: keys typed right after a section switch land once the view's data arrives instead of being dropped.
 */

import React, { useEffect, useState } from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { useViewKeys } from '@src/application/ui/tui/runtime/use-view-keys.ts';
import { useListWindow } from '@src/application/ui/tui/components/windowed-list.tsx';
import { DOWN, tick } from '@tests/integration/application/ui/tui/_keys.ts';

const LOAD_MS = 80;

const useLoaded = (): boolean => {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setReady(true), LOAD_MS);
    return () => clearTimeout(id);
  }, []);
  return ready;
};

const GatedKey = ({ onOpen }: { readonly onOpen: () => void }): React.JSX.Element => {
  const ready = useLoaded();
  useViewKeys([{ keys: ['o'], hint: 'open', enabled: ready, run: onOpen }]);
  return <Text>{ready ? 'ready' : 'loading'}</Text>;
};

const ITEMS = ['a', 'b', 'c'];
const id = (s: string): string => s;

const LoadingList = (): React.JSX.Element => {
  const ready = useLoaded();
  const list = useListWindow<string>({ items: ready ? ITEMS : [], getId: id, visibleRows: 5 });
  return <Text>{`focus:${list.focusedItem ?? 'none'}`}</Text>;
};

describe('type-ahead after a view mounts', () => {
  it('holds a key whose binding is gated off until it enables, then runs it once', async () => {
    const onOpen = vi.fn();
    const { stdin, lastFrame } = render(<GatedKey onOpen={onOpen} />);
    await tick(10);
    stdin.write('o');
    await tick(10);
    expect(onOpen).not.toHaveBeenCalled();
    await tick(LOAD_MS + 80);
    expect(lastFrame()).toContain('ready');
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('runs an enabled binding immediately and does not replay it later', async () => {
    const onOpen = vi.fn();
    const { stdin } = render(<GatedKey onOpen={onOpen} />);
    await tick(LOAD_MS + 80);
    stdin.write('o');
    await tick(20);
    expect(onOpen).toHaveBeenCalledTimes(1);
    await tick(100);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('applies a ↓ typed before the rows load once they arrive', async () => {
    const { stdin, lastFrame } = render(<LoadingList />);
    await tick(10);
    stdin.write(DOWN);
    await tick(LOAD_MS + 80);
    expect(lastFrame()).toContain('focus:b');
  });
});
