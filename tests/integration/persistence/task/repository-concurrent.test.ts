import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { makeTodoTask } from '@tests/fixtures/domain.ts';
import { createFsTaskRepository } from '@src/integration/persistence/task/repository.ts';
import { createFileLocker } from '@src/integration/io/file-locker.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';

/**
 * Regression for issue #189 A1: `saveAll` used to write UNLOCKED while `update` held the
 * per-file lock, so a wholesale rewrite (the cascade-unblock read-modify-`saveAll` in
 * `unblock-task`) could interleave with a concurrent `update` and clobber it. With both paths
 * taking the same `<tasksFile>.lock`, the file is always a single consistent snapshot — the
 * second writer's full set wins, never a torn or half-applied mix.
 */
describe('createFsTaskRepository — concurrent saveAll vs update under a real lock', () => {
  let root: AbsolutePath;
  let cleanup: () => Promise<void>;
  const sprintId = SprintId.generate();

  beforeEach(async () => {
    const tmp = await makeTmpRoot();
    root = tmp.root;
    cleanup = tmp.cleanup;
  });

  afterEach(async () => cleanup());

  it('a concurrent update + saveAll lands as one consistent snapshot (no torn/lost write)', async () => {
    const locker = createFileLocker();
    const repo = createFsTaskRepository({ root, fileLocker: locker });

    const t1 = makeTodoTask({ name: 't1', order: 1 });
    const t2 = makeTodoTask({ name: 't2', order: 2 });
    const seed = await repo.saveAll(sprintId, [t1, t2]);
    expect(seed.ok).toBe(true);

    // `update` flips t1's name in place (2-task set); `saveAll` rewrites a different 3-task set.
    // Whichever wins the lock last fully determines the final file — there is no in-between.
    const renamedT1 = { ...t1, name: 't1-renamed' };
    const t3 = makeTodoTask({ name: 't3', order: 3 });
    const fullRewrite = [t1, t2, t3];

    const [updated, rewritten] = await Promise.all([
      repo.update(sprintId, renamedT1),
      repo.saveAll(sprintId, fullRewrite),
    ]);
    expect(updated.ok).toBe(true);
    expect(rewritten.ok).toBe(true);

    const finalState = await repo.findBySprintId(sprintId);
    if (!finalState.ok) throw new Error('findBySprintId failed');
    const names = JSON.stringify(finalState.value.map((t) => t.name));

    // Because the lock serialises the two read-modify-writes, the final file is whichever
    // complete snapshot the LATER holder produced — never a torn mix. The valid outcomes are:
    //   - update last, on the 2-task seed:        ['t1-renamed', 't2']
    //   - saveAll last, after update:             ['t1', 't2', 't3']  (rewrite clobbers rename)
    //   - update last, on the 3-task rewrite:     ['t1-renamed', 't2', 't3']  (rename inside set)
    // A lost write would surface as a dropped t3 on a 3-task path, or a half-applied JSON.
    const validOutcomes = [
      JSON.stringify(['t1-renamed', 't2']),
      JSON.stringify(['t1', 't2', 't3']),
      JSON.stringify(['t1-renamed', 't2', 't3']),
    ];
    expect(validOutcomes).toContain(names);
  });

  it('many interleaved updates + saveAlls never leave a partial snapshot', async () => {
    const locker = createFileLocker();
    const repo = createFsTaskRepository({ root, fileLocker: locker });

    const base = Array.from({ length: 5 }, (_v, i) => makeTodoTask({ name: `t${String(i)}`, order: i + 1 }));
    const seed = await repo.saveAll(sprintId, base);
    expect(seed.ok).toBe(true);

    // Fan out a mix of full rewrites (saveAll) and single-task updates against one tasks.json.
    // Each saveAll writes the SAME complete 5-task set, so any consistent final state is exactly
    // those 5 tasks; a lost/torn write would surface as a missing task or a renamed survivor.
    const writers: Array<Promise<unknown>> = [];
    for (let i = 0; i < 20; i++) {
      if (i % 2 === 0) {
        writers.push(repo.saveAll(sprintId, base));
      } else {
        const target = base[i % base.length];
        if (target !== undefined) writers.push(repo.update(sprintId, target));
      }
    }
    const results = await Promise.all(writers);
    for (const r of results) expect((r as { ok: boolean }).ok).toBe(true);

    const finalState = await repo.findBySprintId(sprintId);
    if (!finalState.ok) throw new Error('findBySprintId failed');
    expect(finalState.value.map((t) => t.name)).toEqual(['t0', 't1', 't2', 't3', 't4']);
  });
});
