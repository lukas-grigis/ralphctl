import { describe, expect, it } from 'vitest';
import { anyRunActivity, type RunActivityProbe } from '@src/business/_shared/run-activity-probe.ts';

const probe = (active: boolean, calls: string[], name: string): RunActivityProbe => ({
  anyRunActive: async () => {
    calls.push(name);
    return active;
  },
});

describe('anyRunActivity', () => {
  it('is inactive when every probe is', async () => {
    const calls: string[] = [];
    expect(await anyRunActivity(probe(false, calls, 'a'), probe(false, calls, 'b')).anyRunActive()).toBe(false);
    expect(calls).toEqual(['a', 'b']);
  });

  it('is active when any probe is, and stops asking at the first hit', async () => {
    const calls: string[] = [];
    expect(await anyRunActivity(probe(true, calls, 'a'), probe(false, calls, 'b')).anyRunActive()).toBe(true);
    expect(calls).toEqual(['a']);
    expect(await anyRunActivity(probe(false, [], 'a'), probe(true, [], 'b')).anyRunActive()).toBe(true);
  });
});
