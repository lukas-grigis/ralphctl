import { describe, expect, it } from 'vitest';
import { fromJsonTasksFile } from '@src/integration/persistence/task/task.schema.ts';

const TASK_ID = '01900000-0000-7000-8000-000000000001';
const TICKET_ID = '01900000-0000-7000-8000-000000000002';
const REPO_ID = '01900000-0000-7000-8000-00000000abcd';

describe('tasksFileMigrations — v0 → v1 round-trip', () => {
  it('migrates a pre-Wave-8 bare-array file into the versioned envelope', () => {
    const legacy = [
      {
        id: TASK_ID,
        name: 'task-a',
        steps: [],
        verificationCriteria: [],
        order: 1,
        ticketId: TICKET_ID,
        dependsOn: [],
        repositoryId: REPO_ID,
        status: 'todo',
        attempts: [],
      },
    ];
    const parsed = fromJsonTasksFile(legacy);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toHaveLength(1);
    const task = parsed.value[0];
    if (task === undefined) throw new Error('expected task');
    expect(String(task.id)).toBe(TASK_ID);
  });

  it('drops `stdoutTailBytes` from every verifyRuns row inside attempts', () => {
    const legacy = [
      {
        id: TASK_ID,
        name: 'task-a',
        steps: [],
        verificationCriteria: [],
        order: 1,
        ticketId: TICKET_ID,
        dependsOn: [],
        repositoryId: REPO_ID,
        status: 'todo',
        attempts: [
          {
            n: 1,
            startedAt: '2026-04-01T10:00:00.000Z',
            status: 'running',
            finishedAt: null,
            verifyRuns: [
              {
                phase: 'pre',
                ranAt: '2026-04-01T10:00:00.000Z',
                command: 'pnpm test',
                exitCode: 0,
                durationMs: 100,
                stdoutTailBytes: 'OK',
                outcome: 'success',
              },
              {
                phase: 'post',
                ranAt: '2026-04-01T10:01:00.000Z',
                command: 'pnpm test',
                exitCode: 1,
                durationMs: 200,
                stdoutTailBytes: 'FAIL',
                outcome: 'failed',
              },
            ],
          },
        ],
      },
    ];
    const parsed = fromJsonTasksFile(legacy);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const att = parsed.value[0]?.attempts[0];
    expect(att?.verifyRuns).toHaveLength(2);
    for (const row of att?.verifyRuns ?? []) {
      expect((row as unknown as Record<string, unknown>)['stdoutTailBytes']).toBeUndefined();
    }
  });

  it('parses a v1 file unchanged (no migration runs)', () => {
    const current = {
      schemaVersion: 1,
      tasks: [
        {
          id: TASK_ID,
          name: 'task-a',
          steps: [],
          verificationCriteria: [],
          order: 1,
          ticketId: TICKET_ID,
          dependsOn: [],
          repositoryId: REPO_ID,
          status: 'todo' as const,
          attempts: [],
        },
      ],
    };
    const parsed = fromJsonTasksFile(current);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toHaveLength(1);
  });
});
