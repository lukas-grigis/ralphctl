import { describe, expect, it, vi } from 'vitest';

import { CONFIG_DEFAULTS } from '../../config/config-defaults.ts';
import type { ConfigStorePort } from '../../config/config-store-port.ts';
import { Result } from '../../../domain/result.ts';
import { SprintId } from '../../../domain/values/sprint-id.ts';
import { resolveCurrentSprintId } from './resolve-current-sprint.ts';

function makeConfigStore(currentSprint: string | null): ConfigStorePort {
  return {
    load: vi.fn(() => Promise.resolve(Result.ok({ ...CONFIG_DEFAULTS, currentSprint: currentSprint as never }))),
    save: vi.fn(() => Promise.resolve(Result.ok(undefined))),
  };
}

describe('resolveCurrentSprintId', () => {
  it('returns InvalidStateError when no current sprint is set', async () => {
    const r = await resolveCurrentSprintId(makeConfigStore(null));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('invalid-state');
    expect(r.error.entity).toBe('sprint');
    expect(r.error.currentState).toBe('none');
    expect(r.error.hint).toContain('Settings');
  });

  it('returns the parsed SprintId when the config has a valid sprint', async () => {
    const id = '20260429-141522-demo';
    const r = await resolveCurrentSprintId(makeConfigStore(id));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toBe(id);
    // Returned value parses as a SprintId — round-trip through SprintId.parse.
    const reparsed = SprintId.parse(r.value);
    expect(reparsed.ok).toBe(true);
  });

  it('returns InvalidStateError when the persisted id is malformed', async () => {
    // Bypass the typed signature so we can persist a junk string.
    const store: ConfigStorePort = {
      load: vi.fn(() => Promise.resolve(Result.ok({ ...CONFIG_DEFAULTS, currentSprint: 'not-a-sprint-id' as never }))),
      save: vi.fn(() => Promise.resolve(Result.ok(undefined))),
    };
    const r = await resolveCurrentSprintId(store);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('invalid-state');
    expect(r.error.currentState).toBe('invalid-id');
  });
});
