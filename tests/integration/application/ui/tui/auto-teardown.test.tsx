/**
 * Pins `_setup.ts`: a tree rendered (and never unmounted) by one test is torn down before the
 * next test starts, so a failing assertion cannot leak live intervals across tests.
 * The two tests are order-dependent on purpose.
 */
import React from 'react';
import { it, expect } from 'vitest';
import { Text } from 'ink';
import { render } from 'ink-testing-library';

let unmounted = false;

const Probe = (): React.JSX.Element => {
  React.useEffect(() => () => void (unmounted = true), []);
  return <Text>probe</Text>;
};

it('renders without unmounting', async () => {
  const { lastFrame } = render(<Probe />);
  await new Promise((resolve) => setImmediate(resolve));
  expect(lastFrame()).toContain('probe');
});

it('finds the previous test tree already unmounted', () => {
  expect(unmounted).toBe(true);
});
