/**
 * Disk-round-trip tests for the add-ticket wizard. Uses a real `wire()` pointed at a tmp
 * `RALPHCTL_HOME` so a successful submission is verified by reading the actual `sprint.json`
 * the repository writes — not by checking that a mock `save()` was called.
 *
 * Why a parallel test file instead of replacing the existing mock-based ones: the existing
 * tests cover UI-state assertions (frame contents, wizard step progression) and are cheap.
 * These tests cover the persistence contract — schema version, field shape, tickets array
 * structure. Different concern, different file, different failure mode.
 *
 * What a regression here catches:
 *  - Sprint schema change without migration → `sprint.json` parse fails on read
 *  - Ticket schema change → ticket field missing or in wrong shape
 *  - SprintRepository#save side-effect on the wrong file → sprint.json absent / wrong dir
 *  - schemaVersion field accidentally stripped → next load fails
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AddTicketView } from '@src/application/ui/tui/views/add-ticket-view.tsx';
import { makeDraftSprint } from '@tests/fixtures/domain.ts';
import { ENTER } from '@tests/integration/application/ui/tui/_keys.ts';
import { waitFor } from '@tests/integration/application/ui/tui/_wait.ts';
import { renderView } from '@tests/integration/application/ui/tui/_harness.tsx';
import { createRealFsApp, type RealFsApp } from '@tests/helpers/real-fs-app.ts';
import { readSprintDir } from '@tests/helpers/sprint-dir-snapshot.ts';

interface PersistedSprint {
  readonly schemaVersion: number;
  readonly id: string;
  readonly status: string;
  readonly tickets: ReadonlyArray<{
    readonly title: string;
    readonly status: string;
    readonly description?: string;
    readonly link?: string;
  }>;
}

describe('AddTicketView — disk round-trip', () => {
  let app: RealFsApp;

  beforeEach(async () => {
    app = await createRealFsApp();
  });

  afterEach(async () => {
    await app.cleanup();
  });

  it('appends a manually-entered ticket to sprint.json on disk', async () => {
    const sprint = makeDraftSprint();
    const initialSave = await app.deps.sprintRepo.save(sprint);
    expect(initialSave.ok).toBe(true);

    // Confirm the precondition: sprint.json exists with zero tickets.
    const before = await readSprintDir(await app.resolveSprintDir(sprint.id));
    expect(before.tree).toContain('sprint.json');
    const beforeSprint = before.json<PersistedSprint>('sprint.json');
    expect(beforeSprint.schemaVersion).toBe(1);
    expect(beforeSprint.tickets).toHaveLength(0);

    const { result } = renderView(<AddTicketView />, {
      deps: app.deps,
      initial: { id: 'add-ticket', props: { sprintId: sprint.id } },
    });

    // Step 1: skip link.
    await waitFor(() => expect(result.lastFrame()).toContain('Issue link'));
    result.stdin.write(ENTER);

    // Step 2: title.
    await waitFor(() => expect(result.lastFrame()).toMatch(/^\s*▸\s*Title/m));
    result.stdin.write('Wire-up caching layer');
    await waitFor(() => expect(result.lastFrame()).toContain('Wire-up caching layer'));
    result.stdin.write(ENTER);

    // Step 3: description (required).
    await waitFor(() => expect(result.lastFrame()).toContain('Description'));
    result.stdin.write('Adds a per-request cache to the resolver pipeline');
    await waitFor(() => expect(result.lastFrame()).toContain('per-request cache'));
    result.stdin.write(ENTER);

    // Step 4: confirm.
    await waitFor(() => expect(result.lastFrame()).toContain('Add this ticket?'));
    result.stdin.write(ENTER);

    // Wait until disk reflects the appended ticket — the save is async + we don't get a
    // synchronous "save complete" event from the view.
    await waitFor(async () => {
      const snap = await readSprintDir(await app.resolveSprintDir(sprint.id));
      const persisted = snap.json<PersistedSprint>('sprint.json');
      expect(persisted.tickets).toHaveLength(1);
    });

    // Full assertions on what landed on disk.
    const after = await readSprintDir(await app.resolveSprintDir(sprint.id));
    const persisted = after.json<PersistedSprint>('sprint.json');
    expect(persisted.schemaVersion).toBe(1);
    expect(persisted.id).toBe(String(sprint.id));
    expect(persisted.status).toBe('draft');
    expect(persisted.tickets).toHaveLength(1);
    const ticket = persisted.tickets[0]!;
    expect(ticket.title).toBe('Wire-up caching layer');
    expect(ticket.description).toBe('Adds a per-request cache to the resolver pipeline');
    expect(ticket.status).toBe('pending');
  });

  it('a second invocation appends — does not overwrite the existing tickets array', async () => {
    const sprint = makeDraftSprint();
    await app.deps.sprintRepo.save(sprint);

    // First add.
    {
      const { result } = renderView(<AddTicketView />, {
        deps: app.deps,
        initial: { id: 'add-ticket', props: { sprintId: sprint.id } },
      });
      await waitFor(() => expect(result.lastFrame()).toContain('Issue link'));
      result.stdin.write(ENTER);
      await waitFor(() => expect(result.lastFrame()).toMatch(/^\s*▸\s*Title/m));
      result.stdin.write('Ticket one');
      result.stdin.write(ENTER);
      await waitFor(() => expect(result.lastFrame()).toContain('Description'));
      result.stdin.write('first description');
      result.stdin.write(ENTER);
      await waitFor(() => expect(result.lastFrame()).toContain('Add this ticket?'));
      result.stdin.write(ENTER);
      await waitFor(async () => {
        const snap = await readSprintDir(await app.resolveSprintDir(sprint.id));
        expect(snap.json<PersistedSprint>('sprint.json').tickets).toHaveLength(1);
      });
    }

    // Second add.
    {
      const { result } = renderView(<AddTicketView />, {
        deps: app.deps,
        initial: { id: 'add-ticket', props: { sprintId: sprint.id } },
      });
      await waitFor(() => expect(result.lastFrame()).toContain('Issue link'));
      result.stdin.write(ENTER);
      await waitFor(() => expect(result.lastFrame()).toMatch(/^\s*▸\s*Title/m));
      result.stdin.write('Ticket two');
      result.stdin.write(ENTER);
      await waitFor(() => expect(result.lastFrame()).toContain('Description'));
      result.stdin.write('second description');
      result.stdin.write(ENTER);
      await waitFor(() => expect(result.lastFrame()).toContain('Add this ticket?'));
      result.stdin.write(ENTER);
      await waitFor(async () => {
        const snap = await readSprintDir(await app.resolveSprintDir(sprint.id));
        expect(snap.json<PersistedSprint>('sprint.json').tickets).toHaveLength(2);
      });
    }

    const final = await readSprintDir(await app.resolveSprintDir(sprint.id));
    const persisted = final.json<PersistedSprint>('sprint.json');
    expect(persisted.tickets.map((t) => t.title)).toEqual(['Ticket one', 'Ticket two']);
    expect(persisted.tickets.map((t) => t.description)).toEqual(['first description', 'second description']);
  });

  it('empty description never writes to disk', async () => {
    const sprint = makeDraftSprint();
    await app.deps.sprintRepo.save(sprint);

    const before = await readSprintDir(await app.resolveSprintDir(sprint.id));
    const beforeMtime = before.files['sprint.json'];

    const { result } = renderView(<AddTicketView />, {
      deps: app.deps,
      initial: { id: 'add-ticket', props: { sprintId: sprint.id } },
    });

    await waitFor(() => expect(result.lastFrame()).toContain('Issue link'));
    result.stdin.write(ENTER);
    await waitFor(() => expect(result.lastFrame()).toMatch(/^\s*▸\s*Title/m));
    result.stdin.write('Some title');
    result.stdin.write(ENTER);
    // Description step: press Enter with empty buffer; wizard should NOT advance to confirm.
    await waitFor(() => expect(result.lastFrame()).toContain('Description'));
    result.stdin.write(ENTER);
    // Give the (non-)save a tick to happen if it would.
    await new Promise((r) => setTimeout(r, 30));

    const after = await readSprintDir(await app.resolveSprintDir(sprint.id));
    // Same content — no save happened. Catches a regression where the wizard silently
    // commits with an empty description because the required-check was dropped.
    expect(after.files['sprint.json']).toBe(beforeMtime);
    expect(after.json<PersistedSprint>('sprint.json').tickets).toHaveLength(0);
  });
});
