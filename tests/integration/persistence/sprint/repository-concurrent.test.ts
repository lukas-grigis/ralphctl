/**
 * The wired sprint repository's `update` is a locked read-modify-write: concurrent ticket writers
 * each see the others' writes instead of overwriting them with a stale copy.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addTicket } from '@src/domain/entity/sprint.ts';
import { makeDraftSprint, makePendingTicket } from '@tests/fixtures/domain.ts';
import { createRealFsApp, type RealFsApp } from '@tests/helpers/real-fs-app.ts';

describe('wired sprint repository — update', () => {
  let app: RealFsApp;

  beforeEach(async () => {
    app = await createRealFsApp();
  });

  afterEach(async () => app.cleanup());

  it('serialises concurrent read-modify-writes so no ticket is lost', async () => {
    const sprint = makeDraftSprint();
    await app.deps.sprintRepo.save(sprint);
    const titles = ['one', 'two', 'three', 'four', 'five'];

    const results = await Promise.all(
      titles.map((title) =>
        app.deps.sprintRepo.update(sprint.id, (fresh) => addTicket(fresh, makePendingTicket({ title })))
      )
    );

    expect(results.every((r) => r.ok)).toBe(true);
    const after = await app.deps.sprintRepo.findById(sprint.id);
    expect(after.ok && after.value.tickets.map((t) => t.title).sort()).toEqual([...titles].sort());
  });
});
