import { Result } from '@src/domain/result.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';

/**
 * Give a hand-stubbed sprint repo the `update` the real adapter has — an unlocked read → mutate →
 * save over the stub's own `findById` / `save` (in-memory stubs have no second writer to lock out).
 */
export const withUpdate = <R extends Pick<SprintRepository, 'findById' | 'save'>>(
  repo: R
): R & Pick<SprintRepository, 'update'> =>
  Object.assign(repo, {
    async update(...[id, mutate]: Parameters<SprintRepository['update']>) {
      const fresh = await repo.findById(id);
      if (!fresh.ok) return Result.error(fresh.error);
      const next = mutate(fresh.value);
      if (!next.ok) return Result.error(next.error);
      if (next.value === fresh.value) return Result.ok(fresh.value as Sprint);
      const saved = await repo.save(next.value);
      return saved.ok ? Result.ok(next.value) : Result.error(saved.error);
    },
  }) as R & Pick<SprintRepository, 'update'>;
