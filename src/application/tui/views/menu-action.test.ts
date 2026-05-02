/**
 * Type-level smoke for `MenuAction`.
 *
 * The dispatcher in `home-view.tsx` and the chain factory dispatcher in
 * `chain-factory-by-flow.ts` both rely on an exhaustive switch over
 * `MenuAction['kind']` (and `ChainFlow`). This test pins that contract so
 * that adding a new variant breaks the tests at compile time as well as
 * runtime — the runtime check verifies every kind has a stable `actionKey`.
 */
import { describe, expect, it } from 'vitest';
import { actionKey, type ChainFlow, type MenuAction, type MenuGroup } from './menu-action.ts';

describe('MenuAction', () => {
  it('has a stable string fingerprint per variant', () => {
    expect(actionKey({ kind: 'route', viewId: 'home' })).toBe('route:home');
    expect(actionKey({ kind: 'launchChain', flow: 'refine' })).toBe('launchChain:refine');
    expect(actionKey({ kind: 'subMenu', group: 'sprint' })).toBe('subMenu:sprint');
    expect(actionKey({ kind: 'back' })).toBe('back');
  });

  it('actionKey is exhaustive over all kinds', () => {
    // Helper that forces the compiler to exhaustively cover every kind.
    function describeKind(action: MenuAction): string {
      switch (action.kind) {
        case 'route':
          return `route(${action.viewId})`;
        case 'launchChain':
          return `chain(${action.flow})`;
        case 'subMenu':
          return `sub(${action.group})`;
        case 'back':
          return 'back';
      }
      const _exhaustive: never = action;
      return _exhaustive;
    }

    const samples: readonly MenuAction[] = [
      { kind: 'route', viewId: 'home' },
      { kind: 'launchChain', flow: 'plan' },
      { kind: 'subMenu', group: 'project' },
      { kind: 'back' },
    ];
    expect(samples.map(describeKind)).toStrictEqual(['route(home)', 'chain(plan)', 'sub(project)', 'back']);
  });

  it('ChainFlow union is structurally complete', () => {
    // Compile-time exhaustiveness over ChainFlow values used in tests.
    function flowLabel(flow: ChainFlow): string {
      switch (flow) {
        case 'refine':
          return 'Refine';
        case 'plan':
          return 'Plan';
        case 'ideate':
          return 'Ideate';
        case 'execute':
          return 'Execute';
        case 'feedback':
          return 'Feedback';
        case 'create-pr':
          return 'Create PR';
        case 'onboard':
          return 'Onboard';
      }
      const _exhaustive: never = flow;
      return _exhaustive;
    }
    expect(flowLabel('refine')).toBe('Refine');
    expect(flowLabel('feedback')).toBe('Feedback');
    expect(flowLabel('create-pr')).toBe('Create PR');
    expect(flowLabel('onboard')).toBe('Onboard');
  });

  it('MenuGroup union covers all submenu drill-ins', () => {
    function groupLabel(group: MenuGroup): string {
      switch (group) {
        case 'browse':
          return 'Browse';
        case 'sprint':
          return 'Sprint';
        case 'ticket':
          return 'Ticket';
        case 'task':
          return 'Task';
        case 'project':
          return 'Project';
      }
      const _exhaustive: never = group;
      return _exhaustive;
    }
    expect(groupLabel('browse')).toBe('Browse');
    expect(groupLabel('project')).toBe('Project');
  });
});
