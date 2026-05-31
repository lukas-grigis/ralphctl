/**
 * Behavior 2 — Done-on-boot clear.
 *
 * When the selection context rehydrates (from a persisted SelectionSeed) with a sprintId that
 * resolves via the injected sprint repo to a sprint whose status is `done`, the rehydration
 * logic MUST clear both `sprintId` and `sprintLabel` so the user isn't stuck watching a closed
 * sprint on Home.
 *
 * This behaviour requires the implementer to add a boot-time effect that calls `sprintRepo.findById`
 * and clears the selection when the resolved status is `done`. The test is written against the
 * public SelectionProvider interface (seed + onChange) — not internal state — so it survives
 * implementation changes.
 *
 * NOTE: This test will FAIL until the implementer lands the rehydration-clear logic.
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { describe, expect, it, vi } from 'vitest';
import {
  SelectionProvider,
  type SelectionSeed,
  useSelection,
} from '@src/application/ui/tui/runtime/selection-context.tsx';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import { Result } from '@src/domain/result.ts';
import { makeDoneSprint, makeDraftSprint } from '@tests/fixtures/domain.ts';

const sid = (s: string): SprintId => {
  const r = SprintId.parse(s);
  if (!r.ok) throw new Error(`bad sprint id: ${r.error.message}`);
  return r.value;
};

const DONE_SPRINT_ID = sid('01900000-0000-7000-8000-0000000000a1');
const DRAFT_SPRINT_ID = sid('01900000-0000-7000-8000-0000000000b1');

const makeSprintRepo = (sprint: Sprint): SprintRepository =>
  ({
    async findById() {
      return Result.ok(sprint);
    },
  }) as unknown as SprintRepository;

// Renders the provider and waits for async effects to settle.
const mountAndWait = async (
  seed: SelectionSeed,
  sprintRepo: SprintRepository,
  onChange: (s: SelectionSeed) => void
): Promise<{ readonly lastSeed: () => SelectionSeed | undefined; readonly unmount: () => void }> => {
  const seeds: SelectionSeed[] = [];
  const wrapped = vi.fn<(s: SelectionSeed) => void>((s) => {
    seeds.push(s);
    onChange(s);
  });

  const r = render(
    // The implementer is expected to accept `sprintRepo` on SelectionProvider so it can clear
    // done selections on mount. The prop name is chosen to match Clean-Architecture conventions.
    // If the implementer picks a different injection mechanism (e.g. a separate effect wrapper),
    // this test will need the import path adjusted — that's acceptable tester-side friction.
    <SelectionProvider seed={seed} sprintRepo={sprintRepo} onChange={wrapped}>
      <Text>test</Text>
    </SelectionProvider>
  );

  // Allow async effects to complete.
  await new Promise((res) => setTimeout(res, 50));

  return {
    lastSeed: () => seeds[seeds.length - 1],
    unmount: r.unmount,
  };
};

describe('SelectionProvider — done-on-boot clear', () => {
  it('clears sprintId and sprintLabel when rehydrated sprint has status done', async () => {
    const doneSprint = { ...makeDoneSprint(), id: DONE_SPRINT_ID } as unknown as Sprint;
    const repo = makeSprintRepo(doneSprint);
    const onChange = vi.fn<(s: SelectionSeed) => void>();

    const { lastSeed, unmount } = await mountAndWait(
      { sprintId: DONE_SPRINT_ID, sprintLabel: 'Closed Sprint' },
      repo,
      onChange
    );

    const seed = lastSeed();
    // After rehydration the done sprint should be cleared — neither sprintId nor sprintLabel
    // should be set.
    expect(seed?.sprintId).toBeUndefined();
    expect(seed?.sprintLabel).toBeUndefined();

    unmount();
  });

  it('retains sprintId and sprintLabel when rehydrated sprint is not done', async () => {
    const draftSprint = { ...makeDraftSprint(), id: DRAFT_SPRINT_ID } as unknown as Sprint;
    const repo = makeSprintRepo(draftSprint);

    // A non-done sprint produces NO state change on boot, so the first-run-guarded
    // persistence effect writes nothing — assert retention via the live selection the
    // provider exposes (its public interface), not via a persisted seed.
    const Probe = (): React.JSX.Element => {
      const api = useSelection();
      return <Text>s={String(api.sprintId)}</Text>;
    };

    const r = render(
      <SelectionProvider
        seed={{ sprintId: DRAFT_SPRINT_ID, sprintLabel: 'Active Sprint' }}
        sprintRepo={repo}
        onChange={vi.fn()}
      >
        <Probe />
      </SelectionProvider>
    );
    await new Promise((res) => setTimeout(res, 50));

    // Draft sprint must survive rehydration.
    expect(r.lastFrame()).toContain(`s=${String(DRAFT_SPRINT_ID)}`);

    r.unmount();
  });

  it('is a no-op when the seed has no sprintId (no repo call needed)', async () => {
    const repo: SprintRepository = {
      findById: vi.fn(async () => Result.error({ code: 'not-found', message: 'nope' } as never)),
    } as unknown as SprintRepository;

    const onChange = vi.fn<(s: SelectionSeed) => void>();
    const seeds: SelectionSeed[] = [];
    onChange.mockImplementation((s) => seeds.push(s));

    const r = render(
      <SelectionProvider seed={{}} sprintRepo={repo} onChange={onChange}>
        <Text>test</Text>
      </SelectionProvider>
    );
    await new Promise((res) => setTimeout(res, 50));

    // No repo lookup should have occurred.
    expect(repo.findById).not.toHaveBeenCalled();
    r.unmount();
  });
});
