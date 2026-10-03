import { describe, expect, it } from 'vitest';
import {
  flowLaunchability,
  viewRouteFor,
  VIEW_ROUTED_FLOW_IDS,
} from '@src/application/ui/tui/runtime/use-flow-launcher.ts';
import { snapshotFromLoadedSprint } from '@src/application/ui/shared/state-snapshot.ts';
import { makeDraftSprint, makeProject } from '@tests/fixtures/domain.ts';

const draftSnapshot = () => snapshotFromLoadedSprint({ project: makeProject(), sprint: makeDraftSprint(), tasks: [] });

describe('flowLaunchability', () => {
  it('returns the manifest-trigger reason when a flow cannot launch', () => {
    const check = flowLaunchability('implement', draftSnapshot());
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.disabledReason).toMatch(/plan/i);
  });

  it('is ok when the triggers hold', () => {
    expect(flowLaunchability('remove-ticket', draftSnapshot())).toEqual({ ok: true });
  });

  it('reports a loading snapshot and an unknown flow instead of throwing', () => {
    expect(flowLaunchability('implement', undefined)).toEqual({ ok: false, disabledReason: 'still loading' });
    expect(flowLaunchability('nope', draftSnapshot())).toMatchObject({ ok: false });
  });
});

describe('view routes', () => {
  it('routes use-case-shaped flows to their view and leaves chain flows to the launcher', () => {
    const snapshot = draftSnapshot();
    expect(viewRouteFor('doctor', snapshot)).toEqual({ id: 'doctor' });
    expect(viewRouteFor('implement', snapshot)).toBeUndefined();
    expect(VIEW_ROUTED_FLOW_IDS).toContain('add-ticket');
  });
});
