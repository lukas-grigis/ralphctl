import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import type { Save } from '@src/domain/repository/_base/save.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import { makeDoneSprint, makeDraftSprint } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { renameSprintUseCase } from '@src/business/sprint/rename-sprint.ts';

const okSave: Save<Sprint> = {
  async save() {
    return Result.ok(undefined);
  },
};

describe('renameSprintUseCase', () => {
  it('renames an open sprint and persists it', async () => {
    const sprint = makeDraftSprint();
    let saved: Sprint | undefined;
    const repo: Save<Sprint> = {
      async save(s) {
        saved = s;
        return Result.ok(undefined);
      },
    };
    const result = await renameSprintUseCase({
      sprint,
      newName: 'renamed',
      sprintRepo: repo,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    expect(saved?.name).toBe('renamed');
  });

  it('rejects renaming a done sprint (terminal/immutable)', async () => {
    const sprint = makeDoneSprint();
    const result = await renameSprintUseCase({
      sprint,
      newName: 'too-late',
      sprintRepo: okSave,
      logger: noopLogger,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(InvalidStateError);
  });

  it('rejects an empty name', async () => {
    const sprint = makeDraftSprint();
    const result = await renameSprintUseCase({
      sprint,
      newName: '   ',
      sprintRepo: okSave,
      logger: noopLogger,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
  });
});
