import { describe, expect, it } from 'vitest';
import { ROUTE_LABELS } from '@src/application/ui/tui/runtime/nav-tree.ts';
import { VIEW_REGISTRY } from '@src/application/ui/tui/views/view-registry.tsx';

describe('nav-tree ROUTE_LABELS', () => {
  it('labels every registered view and nothing else', () => {
    // The `Record<ViewId, string>` type already fails the build on a missing key; this is the
    // runtime half, which also catches a label left behind for a removed view.
    expect(Object.keys(ROUTE_LABELS).sort()).toEqual(Object.keys(VIEW_REGISTRY).sort());
    for (const [id, label] of Object.entries(ROUTE_LABELS)) expect(label, id).not.toBe('');
  });

  it('names the skills view', () => {
    expect(ROUTE_LABELS.skills).toBe('Skills');
  });
});
