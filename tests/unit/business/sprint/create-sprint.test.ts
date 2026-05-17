import { describe, expect, it } from 'vitest';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { FIXED_PROJECT_ID } from '@tests/fixtures/domain.ts';
import { createSprintUseCase } from '@src/business/sprint/create-sprint.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';

describe('createSprintUseCase', () => {
  it('creates a draft sprint paired with a fresh execution', () => {
    const result = createSprintUseCase({
      projectId: FIXED_PROJECT_ID,
      name: 'kickoff',
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sprint.status).toBe('draft');
      expect(result.value.sprint.name).toBe('kickoff');
      expect(String(result.value.sprint.slug)).toBe('kickoff');
      expect(result.value.sprint.projectId).toBe(FIXED_PROJECT_ID);

      expect(result.value.execution.sprintId).toBe(result.value.sprint.id);
      expect(result.value.execution.branch).toBeNull();
      expect(result.value.execution.pullRequestUrl).toBeNull();
      expect(result.value.execution.setupRanAt).toEqual([]);
    }
  });

  it('returns a ValidationError when the name is empty', () => {
    const result = createSprintUseCase({
      projectId: FIXED_PROJECT_ID,
      name: '   ',
      logger: noopLogger,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ValidationError);
      expect(result.error.field).toBe('sprint.name');
    }
  });
});
