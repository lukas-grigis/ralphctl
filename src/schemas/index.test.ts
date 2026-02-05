import { describe, expect, it } from 'vitest';
import {
  ConfigSchema,
  ImportTasksSchema,
  ProjectSchema,
  RequirementStatusSchema,
  SprintSchema,
  SprintStatusSchema,
  TaskSchema,
  TaskStatusSchema,
  TicketSchema,
} from './index.ts';

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
    projectPath: '/home/user/project',
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
      projectPath: '/tmp',
    };
    const result = TaskSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.blockedBy).toEqual([]);
      expect(result.data.steps).toEqual([]);
    }
  });

  it('rejects task without projectPath', () => {
    const noPath = { ...validTask, projectPath: undefined };
    const result = TaskSchema.safeParse(noPath);
    expect(result.success).toBe(false);
  });

  it('rejects empty projectPath', () => {
    const emptyPath = { ...validTask, projectPath: '' };
    const result = TaskSchema.safeParse(emptyPath);
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
});

describe('TicketSchema', () => {
  const validTicket = {
    id: 'a1b2c3d4',
    externalId: 'JIRA-123',
    title: 'Fix bug',
    description: 'Detailed description',
    link: 'https://jira.example.com/JIRA-123',
    projectName: 'my-app',
    requirementStatus: 'pending',
  };

  it('accepts valid ticket', () => {
    const result = TicketSchema.safeParse(validTicket);
    expect(result.success).toBe(true);
  });

  it('accepts ticket without externalId', () => {
    const noExternalId = { ...validTicket, externalId: undefined };
    const result = TicketSchema.safeParse(noExternalId);
    expect(result.success).toBe(true);
  });

  it('requires id', () => {
    const noId = { ...validTicket, id: undefined };
    const result = TicketSchema.safeParse(noId);
    expect(result.success).toBe(false);
  });

  it('requires projectName', () => {
    const noProject = { id: 'abc123', title: 'Test', requirementStatus: 'pending' };
    const result = TicketSchema.safeParse(noProject);
    expect(result.success).toBe(false);
  });

  it('defaults requirementStatus to pending', () => {
    const noStatus = { id: 'abc123', title: 'Test', projectName: 'my-app' };
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
});

describe('SprintSchema', () => {
  const validSprint = {
    id: '20240115-100000-sprint-1',
    name: 'Sprint 1',
    status: 'draft',
    createdAt: '2024-01-15T10:00:00.000Z',
    activatedAt: null,
    closedAt: null,
    tickets: [],
  };

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
    name: 'my-app',
    displayName: 'My Application',
    repositories: [
      { name: 'frontend', path: '/home/user/frontend' },
      { name: 'backend', path: '/home/user/backend' },
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
});

describe('ImportTasksSchema', () => {
  it('accepts valid import tasks', () => {
    const tasks = [
      { name: 'Task 1', projectPath: '/home/user/project' },
      { name: 'Task 2', description: 'Details', steps: ['Step 1', 'Step 2'], projectPath: '/home/user/project' },
      { id: '1', name: 'Task 3', blockedBy: ['0'], projectPath: '/home/user/project' },
    ];
    const result = ImportTasksSchema.safeParse(tasks);
    expect(result.success).toBe(true);
  });

  it('rejects tasks without name field', () => {
    const tasks = [{ ref: 'abc123', specs: 'Some specs', projectPath: '/home/user/project' }];
    const result = ImportTasksSchema.safeParse(tasks);
    expect(result.success).toBe(false);
  });

  it('rejects tasks with empty name', () => {
    const tasks = [{ name: '', projectPath: '/home/user/project' }];
    const result = ImportTasksSchema.safeParse(tasks);
    expect(result.success).toBe(false);
  });

  it('rejects tasks without projectPath', () => {
    const tasks = [{ name: 'Task 1' }];
    const result = ImportTasksSchema.safeParse(tasks);
    expect(result.success).toBe(false);
  });

  it('rejects tasks with empty projectPath', () => {
    const tasks = [{ name: 'Task 1', projectPath: '' }];
    const result = ImportTasksSchema.safeParse(tasks);
    expect(result.success).toBe(false);
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
        projectPath: '/home/user/project',
      },
    ];
    const result = ImportTasksSchema.safeParse(tasks);
    expect(result.success).toBe(true);
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
