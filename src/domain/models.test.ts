import { describe, expect, it } from 'vitest';
import {
  ConfigSchema,
  ImportTasksSchema,
  ProjectSchema,
  RefinedRequirementsSchema,
  RequirementStatusSchema,
  SprintSchema,
  SprintStatusSchema,
  TaskSchema,
  TaskStatusSchema,
  TicketSchema,
} from './models.ts';

describe('TaskSchema', () => {
  const validTask = {
    id: 'abc123',
    name: 'Test task',
    description: 'A description',
    steps: ['Step 1', 'Step 2'],
    status: 'todo',
    order: 1,
    ticketId: 'JIRA-1',
    blockedBy: ['other-id'],
    repoId: 'repo0001',
  };

  it('accepts valid task', () => {
    const result = TaskSchema.safeParse(validTask);
    expect(result.success).toBe(true);
  });

  it('accepts task with minimal fields', () => {
    const minimal = {
      id: 'abc123',
      name: 'Test',
      status: 'todo',
      order: 1,
      repoId: 'repo0001',
    };
    const result = TaskSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.blockedBy).toEqual([]);
      expect(result.data.steps).toEqual([]);
    }
  });

  it('rejects task without repoId', () => {
    const noRepo = { ...validTask, repoId: undefined };
    const result = TaskSchema.safeParse(noRepo);
    expect(result.success).toBe(false);
  });

  it('rejects empty repoId', () => {
    const emptyRepo = { ...validTask, repoId: '' };
    const result = TaskSchema.safeParse(emptyRepo);
    expect(result.success).toBe(false);
  });

  it('rejects invalid status', () => {
    const badStatus = { ...validTask, status: 'invalid' };
    const result = TaskSchema.safeParse(badStatus);
    expect(result.success).toBe(false);
  });

  it('rejects non-positive order', () => {
    const zeroOrder = { ...validTask, order: 0 };
    const result = TaskSchema.safeParse(zeroOrder);
    expect(result.success).toBe(false);
  });

  it('accepts task with evaluated=true', () => {
    const task = { id: 'abc', name: 'Test', status: 'done', order: 1, repoId: 'repo0001', evaluated: true };
    const result = TaskSchema.safeParse(task);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.evaluated).toBe(true);
  });

  it('defaults evaluated to false', () => {
    const task = { id: 'abc', name: 'Test', status: 'done', order: 1, repoId: 'repo0001' };
    const result = TaskSchema.safeParse(task);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.evaluated).toBe(false);
  });

  it('accepts evaluationOutput as optional string', () => {
    const task = {
      id: 'abc',
      name: 'Test',
      status: 'done',
      order: 1,
      repoId: 'repo0001',
      evaluationOutput: 'Looks good',
    };
    const result = TaskSchema.safeParse(task);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.evaluationOutput).toBe('Looks good');
  });

  it('accepts verificationCriteria as array of strings', () => {
    const task = {
      ...validTask,
      verificationCriteria: ['TypeScript compiles', 'Tests pass'],
    };
    const result = TaskSchema.safeParse(task);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.verificationCriteria).toEqual(['TypeScript compiles', 'Tests pass']);
    }
  });

  it('defaults verificationCriteria to empty array', () => {
    const task = { id: 'abc', name: 'Test', status: 'todo', order: 1, repoId: 'repo0001' };
    const result = TaskSchema.safeParse(task);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.verificationCriteria).toEqual([]);
    }
  });

  it('backward compat: old task JSON without evaluated/evaluationOutput parses successfully', () => {
    const oldTask = { id: 'abc', name: 'Test', status: 'done', order: 1, repoId: 'repo0001' };
    const result = TaskSchema.safeParse(oldTask);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.evaluated).toBe(false);
      expect(result.data.evaluationOutput).toBeUndefined();
    }
  });
});

describe('TicketSchema', () => {
  const validTicket = {
    id: 'a1b2c3d4',
    title: 'Fix bug',
    description: 'Detailed description',
    link: 'https://jira.example.com/JIRA-123',
    requirementStatus: 'pending',
  };

  it('accepts valid ticket', () => {
    const result = TicketSchema.safeParse(validTicket);
    expect(result.success).toBe(true);
  });

  it('requires id', () => {
    const noId = { ...validTicket, id: undefined };
    const result = TicketSchema.safeParse(noId);
    expect(result.success).toBe(false);
  });

  it('requires title', () => {
    const noTitle = { id: 'abc123', requirementStatus: 'pending' };
    const result = TicketSchema.safeParse(noTitle);
    expect(result.success).toBe(false);
  });

  it('defaults requirementStatus to pending', () => {
    const noStatus = { id: 'abc123', title: 'Test' };
    const result = TicketSchema.safeParse(noStatus);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.requirementStatus).toBe('pending');
    }
  });

  it('accepts requirements field', () => {
    const withRequirements = { ...validTicket, requirements: '## Overview\nSome requirements' };
    const result = TicketSchema.safeParse(withRequirements);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.requirements).toBe('## Overview\nSome requirements');
    }
  });

  it('validates link as URL', () => {
    const badLink = { ...validTicket, link: 'not-a-url' };
    const result = TicketSchema.safeParse(badLink);
    expect(result.success).toBe(false);
  });

  it('accepts ticket with affectedRepoIds', () => {
    const withRepos = { ...validTicket, affectedRepoIds: ['repo0001', 'repo0002'] };
    const result = TicketSchema.safeParse(withRepos);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.affectedRepoIds).toEqual(['repo0001', 'repo0002']);
    }
  });

  it('accepts ticket without affectedRepoIds', () => {
    const result = TicketSchema.safeParse(validTicket);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.affectedRepoIds).toBeUndefined();
    }
  });
});

describe('SprintSchema', () => {
  const validSprint = {
    id: '20240115-100000-sprint-1',
    name: 'Sprint 1',
    projectId: 'prj00001',
    status: 'draft',
    createdAt: '2024-01-15T10:00:00.000Z',
    activatedAt: null,
    closedAt: null,
    tickets: [],
  };

  it('parses old Sprint JSON without checkRanAt via .default({})', () => {
    // Simulates loading a sprint.json saved before checkRanAt was introduced.
    // The field must default to {} rather than failing validation.
    const legacySprint = {
      id: '20240115-100000-sprint-1',
      name: 'Sprint 1',
      projectId: 'prj00001',
      status: 'draft',
      createdAt: '2024-01-15T10:00:00.000Z',
      activatedAt: null,
      closedAt: null,
      tickets: [],
      // Note: no checkRanAt field
    };
    const result = SprintSchema.safeParse(legacySprint);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.checkRanAt).toEqual({});
    }
  });

  it('accepts valid sprint', () => {
    const result = SprintSchema.safeParse(validSprint);
    expect(result.success).toBe(true);
  });

  it('validates sprint ID format', () => {
    const badId = { ...validSprint, id: 'invalid-id' };
    const result = SprintSchema.safeParse(badId);
    expect(result.success).toBe(false);
  });

  it('accepts sprint ID with valid format', () => {
    // New format: YYYYMMDD-HHmmss-<slug>
    const goodIds = [
      '20240115-100000-sprint-1', // with name slug
      '20251231-235959-a1b2c3d4', // with uuid8
      '20260204-154532-api-refactor', // with longer slug
      '20260101-000000-q1-2026-planning', // with numbers in slug
    ];
    for (const id of goodIds) {
      const result = SprintSchema.safeParse({ ...validSprint, id });
      expect(result.success).toBe(true);
    }
  });

  it('rejects invalid sprint ID formats', () => {
    const badIds = [
      '2024-01-15-001-a1b2c3d4', // old format
      '20240115-10000-sprint', // missing digit in time
      '2024015-100000-sprint', // missing digit in date
      '20240115-100000-UPPERCASE', // uppercase not allowed
    ];
    for (const id of badIds) {
      const result = SprintSchema.safeParse({ ...validSprint, id });
      expect(result.success).toBe(false);
    }
  });

  it('requires name', () => {
    const noName = { ...validSprint, name: '' };
    const result = SprintSchema.safeParse(noName);
    expect(result.success).toBe(false);
  });
});

describe('ProjectSchema', () => {
  const validProject = {
    id: 'prj00001',
    name: 'my-app',
    displayName: 'My Application',
    repositories: [
      { id: 'repo0001', name: 'frontend', path: '/home/user/frontend' },
      { id: 'repo0002', name: 'backend', path: '/home/user/backend' },
    ],
    description: 'A cool app',
  };

  it('accepts valid project', () => {
    const result = ProjectSchema.safeParse(validProject);
    expect(result.success).toBe(true);
  });

  it('accepts project without description', () => {
    const noDesc = { ...validProject, description: undefined };
    const result = ProjectSchema.safeParse(noDesc);
    expect(result.success).toBe(true);
  });

  it('requires at least one repository', () => {
    const noRepos = { ...validProject, repositories: [] };
    const result = ProjectSchema.safeParse(noRepos);
    expect(result.success).toBe(false);
  });

  it('validates name as slug format', () => {
    const badNames = ['My App', 'my_app', 'MY-APP'];
    for (const name of badNames) {
      const result = ProjectSchema.safeParse({ ...validProject, name });
      expect(result.success).toBe(false);
    }
  });

  it('accepts valid slug names', () => {
    const goodNames = ['my-app', 'frontend', 'backend-api', 'app123'];
    for (const name of goodNames) {
      const result = ProjectSchema.safeParse({ ...validProject, name });
      expect(result.success).toBe(true);
    }
  });
});

describe('ConfigSchema', () => {
  it('accepts valid config with current sprint', () => {
    const config = { currentSprint: 'sprint-1' };
    const result = ConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('accepts config with null current sprint', () => {
    const config = { currentSprint: null };
    const result = ConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('defaults to null current sprint', () => {
    const result = ConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.currentSprint).toBe(null);
    }
  });

  it('accepts config with aiProvider set to claude', () => {
    const result = ConfigSchema.safeParse({ aiProvider: 'claude' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.aiProvider).toBe('claude');
    }
  });

  it('accepts config with aiProvider set to copilot', () => {
    const result = ConfigSchema.safeParse({ aiProvider: 'copilot' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.aiProvider).toBe('copilot');
    }
  });

  it('defaults aiProvider to null', () => {
    const result = ConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.aiProvider).toBe(null);
    }
  });

  it('rejects invalid aiProvider value', () => {
    const result = ConfigSchema.safeParse({ aiProvider: 'invalid' });
    expect(result.success).toBe(false);
  });

  it('accepts evaluationIterations as optional integer >= 0', () => {
    const config = { currentSprint: null, aiProvider: 'claude', evaluationIterations: 2 };
    const result = ConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.evaluationIterations).toBe(2);
  });

  it('accepts evaluationIterations: 0 (disabled)', () => {
    const config = { currentSprint: null, aiProvider: null, evaluationIterations: 0 };
    const result = ConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.evaluationIterations).toBe(0);
  });

  it('rejects evaluationIterations less than 0', () => {
    const config = { evaluationIterations: -1 };
    const result = ConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('rejects evaluationIterations as non-integer', () => {
    const config = { evaluationIterations: 1.5 };
    const result = ConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('accepts missing evaluationIterations (optional field)', () => {
    const config = { currentSprint: null, aiProvider: null };
    const result = ConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.evaluationIterations).toBeUndefined();
  });
});

describe('ImportTasksSchema', () => {
  it('accepts valid import tasks', () => {
    const tasks = [
      { name: 'Task 1', repoId: 'repo0001' },
      { name: 'Task 2', description: 'Details', steps: ['Step 1', 'Step 2'], repoId: 'repo0001' },
      { id: '1', name: 'Task 3', blockedBy: ['0'], repoId: 'repo0001' },
    ];
    const result = ImportTasksSchema.safeParse(tasks);
    expect(result.success).toBe(true);
  });

  it('rejects tasks without name field', () => {
    const tasks = [{ ref: 'abc123', specs: 'Some specs', repoId: 'repo0001' }];
    const result = ImportTasksSchema.safeParse(tasks);
    expect(result.success).toBe(false);
  });

  it('rejects tasks with empty name', () => {
    const tasks = [{ name: '', repoId: 'repo0001' }];
    const result = ImportTasksSchema.safeParse(tasks);
    expect(result.success).toBe(false);
  });

  it('rejects tasks without repoId', () => {
    const tasks = [{ name: 'Task 1' }];
    const result = ImportTasksSchema.safeParse(tasks);
    expect(result.success).toBe(false);
  });

  it('rejects tasks with empty repoId', () => {
    const tasks = [{ name: 'Task 1', repoId: '' }];
    const result = ImportTasksSchema.safeParse(tasks);
    expect(result.success).toBe(false);
  });

  it('accepts tasks with optional verificationCriteria', () => {
    const tasks = [
      {
        name: 'Task with criteria',
        repoId: 'repo0001',
        verificationCriteria: ['Compiles', 'Tests pass'],
      },
      {
        name: 'Task without criteria',
        repoId: 'repo0001',
      },
    ];
    const result = ImportTasksSchema.safeParse(tasks);
    expect(result.success).toBe(true);
  });

  it('accepts tasks with all optional fields', () => {
    const tasks = [
      {
        id: 'setup',
        name: 'Setup project',
        description: 'Configure the project',
        steps: ['Create config', 'Install deps'],
        ticketId: 'JIRA-123',
        blockedBy: [],
        repoId: 'repo0001',
      },
    ];
    const result = ImportTasksSchema.safeParse(tasks);
    expect(result.success).toBe(true);
  });
});

describe('RefinedRequirementsSchema', () => {
  it('accepts valid refined requirements', () => {
    const requirements = [
      { ref: 'TICKET-123', requirements: '## Problem\nSome problem description' },
      { ref: 'ticket-id', requirements: '## Requirements\nDetailed requirements' },
    ];
    const result = RefinedRequirementsSchema.safeParse(requirements);
    expect(result.success).toBe(true);
  });

  it('rejects requirement with empty ref', () => {
    const requirements = [{ ref: '', requirements: 'Some requirements' }];
    const result = RefinedRequirementsSchema.safeParse(requirements);
    expect(result.success).toBe(false);
  });

  it('rejects requirement with empty requirements', () => {
    const requirements = [{ ref: 'TICKET-123', requirements: '' }];
    const result = RefinedRequirementsSchema.safeParse(requirements);
    expect(result.success).toBe(false);
  });

  it('rejects requirement with missing ref field', () => {
    const requirements = [{ requirements: 'Some requirements' }];
    const result = RefinedRequirementsSchema.safeParse(requirements);
    expect(result.success).toBe(false);
  });

  it('rejects requirement with missing requirements field', () => {
    const requirements = [{ ref: 'TICKET-123' }];
    const result = RefinedRequirementsSchema.safeParse(requirements);
    expect(result.success).toBe(false);
  });
});

describe('Status enums', () => {
  it('TaskStatusSchema accepts valid statuses', () => {
    const valid = ['todo', 'in_progress', 'done'];
    for (const status of valid) {
      expect(TaskStatusSchema.safeParse(status).success).toBe(true);
    }
  });

  it('SprintStatusSchema accepts valid statuses', () => {
    const valid = ['draft', 'active', 'closed'];
    for (const status of valid) {
      expect(SprintStatusSchema.safeParse(status).success).toBe(true);
    }
  });

  it('RequirementStatusSchema accepts valid statuses', () => {
    const valid = ['pending', 'approved'];
    for (const status of valid) {
      expect(RequirementStatusSchema.safeParse(status).success).toBe(true);
    }
  });
});
