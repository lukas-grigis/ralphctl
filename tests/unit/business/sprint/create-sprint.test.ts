import { describe, expect, it } from 'vitest';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { FIXED_PROJECT_ID } from '@tests/fixtures/domain.ts';
import { createSprintUseCase, sprintNameProblem } from '@src/business/sprint/create-sprint.ts';
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

describe('sprintNameProblem', () => {
  it.each([
    ['', 'Sprint name is required'],
    ['   ', 'Sprint name is required'],
    ['!!!', 'Sprint name needs at least one letter or digit (a–z, 0–9)'],
    ['日本語', 'Sprint name needs at least one letter or digit (a–z, 0–9)'],
    ['x'.repeat(65), 'Sprint name is too long — slug must be at most 64 characters'],
  ])('rejects %j', (name, message) => {
    expect(sprintNameProblem(name)).toBe(message);
  });

  it('accepts a name createSprintUseCase accepts', () => {
    expect(sprintNameProblem('  Release Plan ')).toBeUndefined();
    expect(createSprintUseCase({ projectId: FIXED_PROJECT_ID, name: 'Release Plan', logger: noopLogger }).ok).toBe(
      true
    );
  });

  it('flags exactly the names createSprintUseCase rejects', () => {
    for (const name of ['', ' ', '!!!', '—', 'a', 'Sprint 1', '· x ·', 'x'.repeat(64), 'x'.repeat(65), '日本語']) {
      const accepted = createSprintUseCase({ projectId: FIXED_PROJECT_ID, name, logger: noopLogger }).ok;
      expect(sprintNameProblem(name) === undefined, name).toBe(accepted);
    }
  });
});
