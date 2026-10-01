/**
 * Sectioned router: one stack per section, `goSection` restores, `pop` climbs to Work, `reset`
 * lands in the entry's own section.
 */

import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { RouterProvider, useRouter, type RouterApi } from '@src/application/ui/tui/runtime/router.tsx';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';

const mount = (initial: Parameters<typeof RouterProvider>[0]['initial']): { api: () => RouterApi } => {
  let latest: RouterApi | undefined;
  const Probe = (): null => {
    latest = useRouter();
    return null;
  };
  render(
    <RouterProvider initial={initial}>
      {() => (
        <>
          <Probe />
        </>
      )}
    </RouterProvider>
  );
  return {
    api: () => {
      if (latest === undefined) throw new Error('router not mounted');
      return latest;
    },
  };
};

const ids = (r: RouterApi): string[] => r.stack.map((e) => e.id);

describe('sectioned router', () => {
  it('restores a section stack when you come back to it', async () => {
    const { api } = mount({ id: 'home' });
    api().goSection('sprints');
    await tick();
    api().push({ id: 'sprint-detail', props: { sprintId: 'x' } });
    await tick();
    expect(api().current.id).toBe('sprint-detail');

    api().goSection('work');
    await tick();
    expect(api().activeSection).toBe('work');
    expect(api().current.id).toBe('home');

    api().goSection('sprints');
    await tick();
    expect(api().current.id).toBe('sprint-detail');
    expect(ids(api())).toEqual(['sprints', 'sprint-detail']);
  });

  it('pop at a non-Work section root goes to Work; at the Work root it is a no-op', async () => {
    const { api } = mount({ id: 'home' });
    api().goSection('sprints');
    await tick();
    expect(api().activeSection).toBe('sprints');

    api().pop();
    await tick();
    expect(api().activeSection).toBe('work');

    api().pop();
    await tick();
    expect(api().activeSection).toBe('work');
    expect(ids(api())).toEqual(['home']);
  });

  it('pop inside a section only goes up one level', async () => {
    const { api } = mount({ id: 'home' });
    api().goSection('system');
    await tick();
    api().push({ id: 'settings' });
    await tick();
    api().pop();
    await tick();
    expect(api().activeSection).toBe('system');
    expect(ids(api())).toEqual(['system']);
  });

  it('reset lands in the entry section as [root, entry]', async () => {
    const { api } = mount({ id: 'home' });
    api().reset({ id: 'execute', props: { sessionId: 's1' } });
    await tick();
    expect(api().activeSection).toBe('runs');
    expect(ids(api())).toEqual(['sessions', 'execute']);
    expect(api().current.props).toEqual({ sessionId: 's1' });
  });

  it('reset onto a section root yields just [root]', async () => {
    const { api } = mount({ id: 'home' });
    api().goSection('sprints');
    await tick();
    api().push({ id: 'sprint-detail' });
    await tick();
    api().reset({ id: 'home' });
    await tick();
    expect(api().activeSection).toBe('work');
    expect(ids(api())).toEqual(['home']);
  });

  it("pressing the active section's goSection resets it to its root", async () => {
    const { api } = mount({ id: 'home' });
    api().goSection('sprints');
    await tick();
    api().push({ id: 'sprint-detail' });
    await tick();
    api().goSection('sprints');
    await tick();
    expect(api().activeSection).toBe('sprints');
    expect(ids(api())).toEqual(['sprints']);
  });

  it('push from Work keeps the entry on the Work stack', async () => {
    const { api } = mount({ id: 'home' });
    api().push({ id: 'execute', props: { sessionId: 's1' } });
    await tick();
    expect(api().activeSection).toBe('work');
    expect(ids(api())).toEqual(['home', 'execute']);
    api().pop();
    await tick();
    expect(ids(api())).toEqual(['home']);
  });

  it('an initial welcome entry starts in section none, and pop there is a no-op', async () => {
    const { api } = mount({ id: 'welcome' });
    expect(api().activeSection).toBe('none');
    api().pop();
    await tick();
    expect(api().activeSection).toBe('none');
    expect(ids(api())).toEqual(['welcome']);
  });

  it('replace swaps only the top of the active stack', async () => {
    const { api } = mount({ id: 'home' });
    api().push({ id: 'flows' });
    await tick();
    api().replace({ id: 'add-ticket' });
    await tick();
    expect(ids(api())).toEqual(['home', 'add-ticket']);
  });
});
