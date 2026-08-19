/**
 * Render + interaction tests for `SkillsView`. Uses a hand-rolled in-memory fake
 * `SkillCatalogPort` (not the real `phase/catalog.ts` filesystem implementation, and not the
 * real `BUNDLED_SKILLS` content) so these tests stay independent of the actual skill catalog —
 * except for `name`, which MUST match a real `BUNDLED_SKILLS` entry for the view to treat a row
 * as "bundled" (`bundledNames` is computed from the real registry import, not from test data).
 * A synthetic name with no `ralphctl-` prefix is used for the manual-entry case, guaranteed to
 * never collide with a real bundled skill.
 */

import { describe, expect, it, vi } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { Settings } from '@src/domain/entity/settings.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import { BUNDLED_SKILLS } from '@src/integration/ai/skills/_engine/registry.ts';
import type { SkillCatalogEntry, SkillCatalogPort } from '@src/integration/ai/skills/_engine/skill-catalog-port.ts';
import { SkillsView } from '@src/application/ui/tui/views/skills-view.tsx';
import { DOWN, ENTER, tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';

const abs = (p: string): AbsolutePath => {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error(`bad path: ${p}`);
  return r.value;
};

/** In-memory fake catalog: mutates a closured entry array so `enable`/`disable`/`update` are visible on the next `list()`. */
const fakeCatalog = (
  initial: readonly SkillCatalogEntry[]
): SkillCatalogPort & { setEntries: (next: readonly SkillCatalogEntry[]) => void } => {
  let entries = initial;
  return {
    setEntries(next) {
      entries = next;
    },
    async list() {
      return Result.ok(entries);
    },
    async enable(name, flows) {
      entries = entries.map((e) =>
        e.name === name
          ? {
              ...e,
              installs: [
                ...e.installs.filter((i) => !flows.includes(i.flow)),
                ...flows.map((f) => ({ flow: f, status: 'in-sync' as const })),
              ],
            }
          : e
      );
      return Result.ok({ copied: [...flows], skipped: [] });
    },
    async disable(name, flows) {
      entries = entries.map((e) =>
        e.name === name ? { ...e, installs: e.installs.filter((i) => !flows.includes(i.flow)) } : e
      );
      return Result.ok(undefined);
    },
    async update(name, flows) {
      entries = entries.map((e) =>
        e.name === name
          ? {
              ...e,
              installs: e.installs.map((i) => (flows.includes(i.flow) ? { ...i, status: 'in-sync' as const } : i)),
            }
          : e
      );
      return Result.ok(undefined);
    },
    async updateAll() {
      const updated: string[] = [];
      entries = entries.map((e) => {
        if (!e.installs.some((i) => i.status === 'update-available')) return e;
        updated.push(e.name);
        return {
          ...e,
          installs: e.installs.map((i) => (i.status === 'update-available' ? { ...i, status: 'in-sync' as const } : i)),
        };
      });
      return Result.ok({ updated });
    },
  };
};

const buildDeps = (skillCatalog: SkillCatalogPort, settings: Settings = DEFAULT_SETTINGS): AppDeps =>
  ({
    skillCatalog,
    settingsRepo: { load: async () => Result.ok(settings) },
    storage: { operatorSkillsRoot: abs('/tmp/ralphctl-skills-root-test') },
  }) as unknown as AppDeps;

const bundledName = (): string => {
  const entry = BUNDLED_SKILLS[0];
  if (entry === undefined) throw new Error('BUNDLED_SKILLS is unexpectedly empty');
  return entry.name;
};

describe('SkillsView', () => {
  it('renders a bundled skill row with its description and the always-on default chip', async () => {
    const name = bundledName();
    const catalog = fakeCatalog([
      {
        name,
        description: 'Confirm scope before diving into work',
        defaultFor: ['implement'],
        recommendedFor: [],
        installs: [],
      },
    ]);
    const { result } = renderView(<SkillsView />, { deps: buildDeps(catalog), initial: { id: 'skills' } });
    await waitForViewReady(result, (f) => f.includes(name));
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain(name);
    expect(frame).toContain('Confirm scope before diving into work');
    // Implement is default-on: the phaseDone glyph ('■') marks it regardless of any install row.
    expect(frame).toContain('■ imp');
    // Refine is neither default-on nor installed: the phaseDisabled glyph ('◌') marks it.
    expect(frame).toContain('◌ ref');
    // No opt-in copies exist anywhere — the hint should point at the enable key + folder.
    expect(frame).toContain('no opt-in copies yet');
    // DESIGN-SYSTEM §6.4 — arrows only in the per-view hint strip; j/k stays bound but unadvertised.
    expect(frame).not.toContain('j/k');
  });

  it('shows the "(manual)" tag for a phase-folder entry with no matching bundled skill', async () => {
    const catalog = fakeCatalog([
      {
        name: 'hand-authored-thing',
        description: 'dropped in by hand',
        defaultFor: [],
        recommendedFor: [],
        installs: [{ flow: 'implement', status: 'manual' }],
      },
    ]);
    const { result } = renderView(<SkillsView />, { deps: buildDeps(catalog), initial: { id: 'skills' } });
    await waitForViewReady(result, (f) => f.includes('hand-authored-thing'));
    expect(result.lastFrame() ?? '').toContain('(manual)');
  });

  it('enable: opens the flow picker with recommendedFor preselected, default-on flows disabled', async () => {
    const name = bundledName();
    const catalog = fakeCatalog([
      {
        name,
        description: 'a recommendable skill',
        defaultFor: ['refine'],
        recommendedFor: ['plan', 'implement'],
        installs: [],
      },
    ]);
    const { result } = renderView(<SkillsView />, { deps: buildDeps(catalog), initial: { id: 'skills' } });
    await waitForViewReady(result, (f) => f.includes(name));

    result.stdin.write('e');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('Enable'));
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain(`Enable "${name}" for:`);
    // Refine is default-on: shown but disabled with an explanatory description.
    expect(frame).toContain('Refine');
    expect(frame).toContain('already default-on');
    // Plan + Implement are recommended: preselected (checked).
    expect(frame).toMatch(/\[[xX✔✓]]\s*Plan/);
    expect(frame).toMatch(/\[[xX✔✓]]\s*Implement/);
  });

  it('enable: submitting the preselected flows calls enable() and the row reflects in-sync afterwards', async () => {
    const name = bundledName();
    const catalog = fakeCatalog([{ name, description: 'x', defaultFor: [], recommendedFor: ['plan'], installs: [] }]);
    const { result } = renderView(<SkillsView />, { deps: buildDeps(catalog), initial: { id: 'skills' } });
    await waitForViewReady(result, (f) => f.includes(name));

    result.stdin.write('e');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('Enable'));
    result.stdin.write(ENTER);
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('enabled'));

    const listed = await catalog.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value[0]?.installs).toEqual([{ flow: 'plan', status: 'in-sync' }]);
  });

  it('enable: a manual entry (no bundled counterpart) rejects with an error toast, no picker opens', async () => {
    const catalog = fakeCatalog([
      {
        name: 'hand-authored-thing',
        description: 'x',
        defaultFor: [],
        recommendedFor: [],
        installs: [{ flow: 'implement', status: 'manual' }],
      },
    ]);
    const { result } = renderView(<SkillsView />, { deps: buildDeps(catalog), initial: { id: 'skills' } });
    await waitForViewReady(result, (f) => f.includes('hand-authored-thing'));

    result.stdin.write('e');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('nothing to enable'));
    expect(result.lastFrame() ?? '').not.toContain('Enable "hand-authored-thing" for:');
  });

  it('disable: removes a non-destructive install directly, no confirm', async () => {
    const name = bundledName();
    const catalog = fakeCatalog([
      { name, description: 'x', defaultFor: [], recommendedFor: [], installs: [{ flow: 'plan', status: 'in-sync' }] },
    ]);
    const { result } = renderView(<SkillsView />, { deps: buildDeps(catalog), initial: { id: 'skills' } });
    await waitForViewReady(result, (f) => f.includes(name));

    result.stdin.write('d');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('Disable'));
    result.stdin.write(' '); // toggle Plan on
    await tick();
    result.stdin.write(ENTER);
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('disabled'));

    const listed = await catalog.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value[0]?.installs).toEqual([]);
  });

  it('disable: confirms before removing a locally-modified install', async () => {
    const name = bundledName();
    const catalog = fakeCatalog([
      {
        name,
        description: 'x',
        defaultFor: [],
        recommendedFor: [],
        installs: [{ flow: 'plan', status: 'locally-modified' }],
      },
    ]);
    const { result } = renderView(<SkillsView />, { deps: buildDeps(catalog), initial: { id: 'skills' } });
    await waitForViewReady(result, (f) => f.includes(name));

    result.stdin.write('d');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('Disable'));
    result.stdin.write(' ');
    await tick();
    result.stdin.write(ENTER);
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('permanently lost'));
    // The install must still be present — nothing happened until the confirm is answered.
    const midway = await catalog.list();
    expect(midway.ok && midway.value[0]?.installs).toEqual([{ flow: 'plan', status: 'locally-modified' }]);

    result.stdin.write('y');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('disabled'));
    const after = await catalog.list();
    expect(after.ok && after.value[0]?.installs).toEqual([]);
  });

  it('update-all: updates every stale install and reports the count', async () => {
    const [first, second] = BUNDLED_SKILLS;
    if (first === undefined || second === undefined || first.name === second.name) {
      throw new Error('test requires at least two distinct BUNDLED_SKILLS entries');
    }
    const catalog = fakeCatalog([
      {
        name: first.name,
        description: 'x',
        defaultFor: [],
        recommendedFor: [],
        installs: [{ flow: 'plan', status: 'update-available' }],
      },
      {
        name: second.name,
        description: 'y',
        defaultFor: [],
        recommendedFor: [],
        installs: [{ flow: 'implement', status: 'in-sync' }],
      },
    ]);
    const { result } = renderView(<SkillsView />, { deps: buildDeps(catalog), initial: { id: 'skills' } });
    await waitForViewReady(result, (f) => f.includes(first.name));

    result.stdin.write('U');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('updated 1 skill'));

    const listed = await catalog.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value[0]?.installs).toEqual([{ flow: 'plan', status: 'in-sync' }]);
    expect(listed.value[1]?.installs).toEqual([{ flow: 'implement', status: 'in-sync' }]);
  });

  it('propagates a StorageError from list() as a load-error row', async () => {
    const catalog: SkillCatalogPort = {
      list: vi.fn(async () => Result.error(new StorageError({ subCode: 'io', message: 'boom' }))),
      enable: vi.fn(),
      disable: vi.fn(),
      update: vi.fn(),
      updateAll: vi.fn(),
    } as unknown as SkillCatalogPort;
    const { result } = renderView(<SkillsView />, { deps: buildDeps(catalog), initial: { id: 'skills' } });
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('Failed to load'));
    expect(result.lastFrame() ?? '').toContain('Failed to load the skill catalog.');
  });

  it('reload (r) re-fetches: state mutated behind the view appears after r', async () => {
    const [first, second] = BUNDLED_SKILLS;
    if (first === undefined || second === undefined || first.name === second.name) {
      throw new Error('test requires at least two distinct BUNDLED_SKILLS entries');
    }
    const catalog = fakeCatalog([
      { name: first.name, description: 'x', defaultFor: [], recommendedFor: [], installs: [] },
    ]);
    const { result } = renderView(<SkillsView />, { deps: buildDeps(catalog), initial: { id: 'skills' } });
    await waitForViewReady(result, (f) => f.includes(first.name));
    expect(result.lastFrame() ?? '').not.toContain(second.name);
    // Mutate the underlying catalog OUTSIDE the view, then reload — the new entry appearing
    // proves `r` actually re-fetched rather than re-rendering stale state.
    catalog.setEntries([
      { name: first.name, description: 'x', defaultFor: [], recommendedFor: [], installs: [] },
      { name: second.name, description: 'y', defaultFor: [], recommendedFor: [], installs: [] },
    ]);
    result.stdin.write(DOWN);
    await tick();
    result.stdin.write('r');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes(second.name), {
      label: `the reloaded catalog rendered '${second.name}'`,
    });
    expect(result.lastFrame() ?? '').toContain(second.name);
  });

  it('update (u): declining the overwrite confirm leaves the copy untouched', async () => {
    const name = bundledName();
    const catalog = fakeCatalog([
      {
        name,
        description: 'x',
        defaultFor: [],
        recommendedFor: [],
        installs: [{ flow: 'plan', status: 'locally-modified' }],
      },
    ]);
    const { result } = renderView(<SkillsView />, { deps: buildDeps(catalog), initial: { id: 'skills' } });
    await waitForViewReady(result, (f) => f.includes(name));

    result.stdin.write('u');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('Overwrite?'));
    // Nothing written until the confirm is answered.
    const midway = await catalog.list();
    expect(midway.ok && midway.value[0]?.installs).toEqual([{ flow: 'plan', status: 'locally-modified' }]);

    result.stdin.write('n');
    await waitForPredicate(() => !(result.lastFrame() ?? '').includes('Overwrite?'));
    const declined = await catalog.list();
    expect(declined.ok && declined.value[0]?.installs).toEqual([{ flow: 'plan', status: 'locally-modified' }]);
  });

  it('update (u): accepting the overwrite confirm updates the locally-modified copy', async () => {
    const name = bundledName();
    const catalog = fakeCatalog([
      {
        name,
        description: 'x',
        defaultFor: [],
        recommendedFor: [],
        installs: [{ flow: 'plan', status: 'locally-modified' }],
      },
    ]);
    const { result } = renderView(<SkillsView />, { deps: buildDeps(catalog), initial: { id: 'skills' } });
    await waitForViewReady(result, (f) => f.includes(name));

    result.stdin.write('u');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('Overwrite?'));
    result.stdin.write('y');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('updated'));
    const after = await catalog.list();
    expect(after.ok && after.value[0]?.installs).toEqual([{ flow: 'plan', status: 'in-sync' }]);
  });

  it('update (u): an in-sync-only row reports already up to date', async () => {
    const name = bundledName();
    const catalog = fakeCatalog([
      { name, description: 'x', defaultFor: [], recommendedFor: [], installs: [{ flow: 'plan', status: 'in-sync' }] },
    ]);
    const { result } = renderView(<SkillsView />, { deps: buildDeps(catalog), initial: { id: 'skills' } });
    await waitForViewReady(result, (f) => f.includes(name));
    result.stdin.write('u');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('already up to date'), {
      label: "the 'already up to date' notice rendered",
    });
    expect(result.lastFrame() ?? '').toContain('already up to date');
  });

  it('offers Create PR — its view / CLI compose a skill source directly, same as any mounting flow', async () => {
    const name = bundledName();
    const catalog = fakeCatalog([
      {
        name,
        description: 'defaulted onto createPr in the registry',
        defaultFor: ['createPr'],
        recommendedFor: ['createPr', 'plan'],
        installs: [],
      },
    ]);
    const { result } = renderView(<SkillsView />, { deps: buildDeps(catalog), initial: { id: 'skills' } });
    await waitForViewReady(result, (f) => f.includes(name));
    const frame = result.lastFrame() ?? '';
    // createPr is default-on: the phaseDone glyph ('■') marks it like any other mounting flow.
    expect(frame).toContain('■ pr');
    expect(frame).not.toContain('◌ pr');

    result.stdin.write('e');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('Enable'));
    const picker = result.lastFrame() ?? '';
    // Offered but disabled — it's already default-on for createPr, same treatment as any flow.
    expect(picker).toContain('Create PR');
    expect(picker).toContain('already default-on');
    // Plan is recommended (not default-on): still preselected.
    expect(picker).toMatch(/\[[xX✔✓]]\s*Plan/);
  });

  it('renders "default, off (saved)" when a durable opt-out disables a default flow', async () => {
    const name = bundledName();
    const catalog = fakeCatalog([
      { name, description: 'x', defaultFor: ['implement'], recommendedFor: [], installs: [] },
    ]);
    const settings = {
      ...DEFAULT_SETTINGS,
      ai: { ...DEFAULT_SETTINGS.ai, skills: { implement: { disabled: [name] } } },
    } as Settings;
    const { result } = renderView(<SkillsView />, {
      deps: buildDeps(catalog, settings),
      initial: { id: 'skills' },
    });
    await waitForViewReady(result, (f) => f.includes(name));
    const frame = result.lastFrame() ?? '';
    // The saved opt-out demotes the "always on" chip: muted ◌ instead of highlighted ■.
    expect(frame).toContain('◌ imp');
    expect(frame).not.toContain('■ imp');
  });

  it('clear opt-out (c): removes a durable disable and the row reflects it after reload', async () => {
    const name = bundledName();
    const catalog = fakeCatalog([
      { name, description: 'x', defaultFor: ['implement'], recommendedFor: [], installs: [] },
    ]);
    // `load` mirrors the repository's read-after-write: the second load (triggered by the
    // action's reload()) must see whatever `save` last wrote, not the original fixture.
    let current: Settings = {
      ...DEFAULT_SETTINGS,
      ai: { ...DEFAULT_SETTINGS.ai, skills: { implement: { disabled: [name] } } },
    };
    const deps = {
      skillCatalog: catalog,
      settingsRepo: {
        load: async () => Result.ok(current),
        save: async (next: Settings) => {
          current = next;
          return Result.ok(undefined);
        },
      },
      storage: { operatorSkillsRoot: abs('/tmp/ralphctl-skills-root-test') },
    } as unknown as AppDeps;

    const { result } = renderView(<SkillsView />, { deps, initial: { id: 'skills' } });
    await waitForViewReady(result, (f) => f.includes(name));
    expect(result.lastFrame() ?? '').toContain('◌ imp');

    result.stdin.write('c');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('■ imp'));

    expect(current.ai.skills?.implement?.disabled).toEqual([]);
  });

  it('clear opt-out (c) is a no-op when the focused skill has no saved opt-out anywhere', async () => {
    const name = bundledName();
    const catalog = fakeCatalog([
      { name, description: 'x', defaultFor: ['implement'], recommendedFor: [], installs: [] },
    ]);
    const save = vi.fn(async () => Result.ok(undefined));
    const deps = {
      skillCatalog: catalog,
      settingsRepo: { load: async () => Result.ok(DEFAULT_SETTINGS), save },
      storage: { operatorSkillsRoot: abs('/tmp/ralphctl-skills-root-test') },
    } as unknown as AppDeps;

    const { result } = renderView(<SkillsView />, { deps, initial: { id: 'skills' } });
    await waitForViewReady(result, (f) => f.includes(name));
    // No saved opt-out anywhere for this entry — the always-on chip is already showing.
    expect(result.lastFrame() ?? '').toContain('■ imp');

    result.stdin.write('c');
    await tick();
    expect(save).not.toHaveBeenCalled();
  });
});
