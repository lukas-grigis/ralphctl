import React from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RALPHCTL_HOME_ENV } from '@src/application/bootstrap/storage-paths.ts';
import { launchTui } from '@src/application/ui/tui/launch.ts';
import { CURRENT_DATA_VERSION, writeDataVersion } from '@src/integration/persistence/data-migration/version-marker.ts';
import { type CliHome, createCliHome } from '@tests/e2e/cli/_harness.ts';
import { seedLegacyProject, freshId } from '@tests/integration/persistence/data-migration/_seed.ts';
import { ENTER, RIGHT } from '@tests/integration/application/ui/tui/_keys.ts';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';

// The Ink host and the App are the two things launchTui hands off to; capturing the render thunk keeps
// launchTui's own gate decision (and its pause/resume remount) under test without a real terminal.
const host = vi.hoisted(() => ({
  renderElement: undefined as (() => React.ReactElement) | undefined,
  shutdown: undefined as (() => void) | undefined,
}));

vi.mock('@src/application/ui/shared/ink-host.ts', () => ({
  createInkHost: (deps: { renderElement: () => React.ReactElement }) => {
    host.renderElement = deps.renderElement;
    return {
      runInTerminal: async <T,>(fn: () => Promise<T>): Promise<T> => fn(),
      waitForShutdown: () =>
        new Promise<void>((resolve) => {
          host.shutdown = resolve;
        }),
    };
  },
}));

vi.mock('@src/application/ui/tui/App.tsx', () => ({
  App: () => <Text>APP-MOUNTED</Text>,
}));

const GATE_COPY = 'Migrate now';
const APP_COPY = 'APP-MOUNTED';

describe('launchTui migration gate wiring', () => {
  const originalStdinTty = process.stdin.isTTY;
  const originalStdoutTty = process.stdout.isTTY;
  const originalHome = process.env[RALPHCTL_HOME_ENV];
  let cli: CliHome;
  let launched: Promise<void> | undefined;

  beforeEach(async () => {
    cli = await createCliHome();
    host.renderElement = undefined;
    host.shutdown = undefined;
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    process.env[RALPHCTL_HOME_ENV] = String(cli.home);
  });

  afterEach(async () => {
    host.shutdown?.();
    await launched;
    launched = undefined;
    process.stdin.isTTY = originalStdinTty;
    process.stdout.isTTY = originalStdoutTty;
    if (originalHome === undefined) delete process.env[RALPHCTL_HOME_ENV];
    else process.env[RALPHCTL_HOME_ENV] = originalHome;
    await cli.cleanup();
  });

  const launch = async (): Promise<() => React.ReactElement> => {
    launched = launchTui();
    await waitForPredicate(() => host.renderElement !== undefined, { label: 'launchTui mounted the host' });
    return host.renderElement!;
  };

  it('shows the gate first, then renders App (not the gate) on a pause/resume remount', async () => {
    await seedLegacyProject(String(cli.paths.dataRoot), freshId(), 'alpha-project');
    const renderElement = await launch();

    const first = render(renderElement());
    await waitForPredicate(() => first.lastFrame()?.includes(GATE_COPY) === true, { label: 'gate consent screen' });
    expect(first.lastFrame()).not.toContain(APP_COPY);

    first.stdin.write(RIGHT);
    first.stdin.write(ENTER);
    await waitForPredicate(() => first.lastFrame()?.includes(APP_COPY) === true, { label: 'App after gate resolves' });
    first.unmount();

    const remounted = render(renderElement());
    expect(remounted.lastFrame()).toContain(APP_COPY);
    expect(remounted.lastFrame()).not.toContain(GATE_COPY);
    remounted.unmount();
  });

  it('never shows the gate when no migration is pending', async () => {
    const stamped = await writeDataVersion(cli.paths.dataRoot, {
      dataVersion: CURRENT_DATA_VERSION,
      lastWrittenByAppVersion: '0.0.0',
    });
    expect(stamped.ok).toBe(true);
    const renderElement = await launch();

    const mounted = render(renderElement());
    expect(mounted.lastFrame()).toContain(APP_COPY);
    expect(mounted.lastFrame()).not.toContain(GATE_COPY);
    mounted.unmount();
  });
});
