import React from 'react';
import { Text } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { type AsyncLoadState, useAsyncLoad } from '@src/application/ui/tui/runtime/use-async-load.ts';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';

afterEach(() => cleanup());

describe('useAsyncLoad', () => {
  it('reports loading, not the previous value, on the first render after deps change', async () => {
    const renders: Array<{ readonly id: string; readonly state: AsyncLoadState<string, unknown> }> = [];
    const pending = new Promise<string>(() => undefined);
    const Probe = ({ id }: { readonly id: string }): React.JSX.Element => {
      const { state } = useAsyncLoad(() => (id === 'a' ? Promise.resolve('value-a') : pending), [id]);
      renders.push({ id, state });
      return <Text>{state.kind === 'ok' ? state.value : state.kind}</Text>;
    };

    const { rerender, lastFrame } = render(<Probe id="a" />);
    await waitForPredicate(() => (lastFrame() ?? '').includes('value-a'));

    const switchedAt = renders.length;
    rerender(<Probe id="b" />);
    await waitForPredicate(() => (lastFrame() ?? '').includes('loading'));

    const afterSwitch = renders.slice(switchedAt);
    expect(afterSwitch.length).toBeGreaterThan(0);
    expect(afterSwitch[0]).toEqual({ id: 'b', state: { kind: 'loading' } });
    expect(afterSwitch.every((r) => r.state.kind !== 'ok')).toBe(true);
  });

  it('keeps the settled value across a same-deps reload render', async () => {
    let reload: () => void = () => undefined;
    const Probe = (): React.JSX.Element => {
      const result = useAsyncLoad(() => Promise.resolve('value'), ['same']);
      reload = result.reload;
      return <Text>{result.state.kind === 'ok' ? result.state.value : result.state.kind}</Text>;
    };

    const { lastFrame } = render(<Probe />);
    await waitForPredicate(() => (lastFrame() ?? '').includes('value'));
    reload();
    await waitForPredicate(() => (lastFrame() ?? '').includes('value'));
    expect(lastFrame()).toContain('value');
  });
});
