/**
 * Legacy sprint-directory migration round-trip. Writes a sprint dir in the pre-audit (v0) shape
 * directly to disk — bare `Task[]` root in tasks.json, `stdoutTailBytes` on setupRanAt /
 * verifyRuns, `checkRuns` predecessor field — and asserts the wired repositories load it
 * cleanly + re-emit canonical v1 shape on the next save.
 *
 * The audit (`07-progress-vs-chain-log.md`, `06-execution-json-slimming.md`) promised
 * "in-flight sprints upgrade transparently." This test is the fence on that promise.
 *
 * Any regression in `sprint/migrations.ts`, `sprint-execution/migrations.ts`, or
 * `task/migrations.ts` shows up here as a parse error or a stale field surviving the round-trip.
 * That is the exact bug class that bites in production but is invisible to every existing test
 * (current tests construct domain entities → write → read; they never start from an old shape
 * on disk).
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRealFsApp, type RealFsApp } from '@tests/helpers/real-fs-app.ts';
import { readSprintDir } from '@tests/helpers/sprint-dir-snapshot.ts';

describe('persistence — legacy (v0) sprint dir migration round-trip', () => {
  let app: RealFsApp;

  beforeEach(async () => {
    app = await createRealFsApp();
  });

  afterEach(async () => {
    await app.cleanup();
  });

  it('loads a pre-audit sprint dir with no errors and rewrites canonical v1 on save', async () => {
    // SprintId UUIDv7 — stable shape so the storage path resolves the same way every run.
    const sprintId = '01900000-0000-7000-8000-0000000000aa';
    const projectId = '01900000-0000-7000-8000-000000000001';
    const repositoryId = '01900000-0000-7000-8000-000000000002';
    const ticketId = '01900000-0000-7000-8000-000000000003';
    const taskId = '01900000-0000-7000-8000-000000000004';
    const sprintDir = app.sprintDir(sprintId as unknown as never);

    await fs.mkdir(sprintDir, { recursive: true });

    // --- sprint.json (v0: no schemaVersion field) ----------------------------------
    const legacySprint = {
      id: sprintId,
      slug: 'legacy-sprint',
      name: 'Legacy sprint from pre-audit shape',
      projectId,
      status: 'draft',
      plannedAt: null,
      activatedAt: null,
      reviewAt: null,
      doneAt: null,
      tickets: [
        {
          id: ticketId,
          slug: 'legacy-ticket',
          title: 'old ticket',
          description: 'pre-audit ticket body',
          status: 'pending',
        },
      ],
    };
    await fs.writeFile(join(sprintDir, 'sprint.json'), JSON.stringify(legacySprint, null, 2), 'utf8');

    // --- execution.json (v0: stdoutTailBytes / stderrTailBytes on setupRanAt) ------
    const legacyExecution = {
      // No schemaVersion. No top-level `id` (old shape; migration fills from sprintId).
      sprintId,
      branch: 'feature/legacy',
      pullRequestUrl: null,
      setupRanAt: [
        {
          ranAt: '2026-05-01T10:00:00.000Z',
          repositoryId,
          command: 'pnpm install',
          exitCode: 0,
          durationMs: 1234,
          outcome: 'success',
          stdoutTailBytes: 'this body should be dropped by the migration',
          stderrTailBytes: 'this too',
        },
      ],
    };
    await fs.writeFile(join(sprintDir, 'execution.json'), JSON.stringify(legacyExecution, null, 2), 'utf8');

    // --- tasks.json (v0: bare Task[] root with checkRuns + stdoutTailBytes) --------
    const legacyTasks = [
      {
        id: taskId,
        slug: 'legacy-task',
        name: 'legacy-task',
        order: 1,
        ticketId,
        repositoryId,
        steps: ['do step 1'],
        verificationCriteria: ['it works'],
        dependsOn: [],
        externalRefs: [],
        maxAttempts: 3,
        status: 'todo',
        attempts: [
          {
            n: 1,
            status: 'failed',
            startedAt: '2026-05-01T10:30:00.000Z',
            finishedAt: '2026-05-01T10:35:00.000Z',
            sessionId: 'sess-legacy',
            // Legacy field name — migration renames it to `verifyRuns`.
            checkRuns: [
              {
                phase: 'pre',
                ranAt: '2026-05-01T10:31:00.000Z',
                command: 'pnpm test',
                exitCode: 1,
                durationMs: 500,
                outcome: 'failed',
                // Legacy embedded body — migration drops it (full output now lives at
                // <sprintDir>/logs/verify/<task-id>/...).
                stdoutTailBytes: 'old tail content — should be dropped',
              },
            ],
          },
        ],
      },
    ];
    await fs.writeFile(join(sprintDir, 'tasks.json'), JSON.stringify(legacyTasks, null, 2), 'utf8');

    // ----- Load through the wired repos -------------------------------------------
    const sprintLoad = await app.deps.sprintRepo.findById(sprintId as unknown as never);
    expect(
      sprintLoad.ok,
      sprintLoad.ok
        ? ''
        : `sprintRepo.findById failed: ${(sprintLoad as { error: { message?: string } }).error.message ?? 'unknown'}`
    ).toBe(true);
    if (!sprintLoad.ok) return;

    const execLoad = await app.deps.sprintExecutionRepo.findById(sprintId as unknown as never);
    expect(
      execLoad.ok,
      execLoad.ok
        ? ''
        : `executionRepo.findById failed: ${(execLoad as { error: { message?: string } }).error.message ?? 'unknown'}`
    ).toBe(true);
    if (!execLoad.ok) return;

    const tasksLoad = await app.deps.taskRepo.findBySprintId(sprintId as unknown as never);
    expect(
      tasksLoad.ok,
      tasksLoad.ok
        ? ''
        : `taskRepo.findBySprintId failed: ${(tasksLoad as { error: { message?: string } }).error.message ?? 'unknown'}`
    ).toBe(true);
    if (!tasksLoad.ok) return;

    expect(sprintLoad.value.tickets).toHaveLength(1);
    expect(sprintLoad.value.tickets[0]?.title).toBe('old ticket');
    expect(execLoad.value.setupRanAt).toHaveLength(1);
    expect(tasksLoad.value).toHaveLength(1);

    // ----- Re-save and verify canonical v1 shape ----------------------------------
    await app.deps.sprintRepo.save(sprintLoad.value);
    await app.deps.sprintExecutionRepo.save(execLoad.value);
    await app.deps.taskRepo.saveAll(sprintId as unknown as never, tasksLoad.value);

    const after = await readSprintDir(sprintDir);
    const persistedSprint = after.json<{ schemaVersion: number }>('sprint.json');
    const persistedExec = after.json<{
      schemaVersion: number;
      setupRanAt: ReadonlyArray<Record<string, unknown>>;
      id: string;
    }>('execution.json');
    const persistedTasks = after.json<{
      schemaVersion: number;
      tasks: ReadonlyArray<{
        attempts: ReadonlyArray<{ verifyRuns?: ReadonlyArray<Record<string, unknown>>; checkRuns?: unknown }>;
      }>;
    }>('tasks.json');

    expect(persistedSprint.schemaVersion).toBe(1);
    expect(persistedExec.schemaVersion).toBe(1);
    expect(persistedTasks.schemaVersion).toBe(1);

    // top-level id was filled in from sprintId on the way through
    expect(persistedExec.id).toBe(sprintId);

    // tail-bytes were dropped — both at the execution.json and the verifyRuns level
    expect(persistedExec.setupRanAt[0]).not.toHaveProperty('stdoutTailBytes');
    expect(persistedExec.setupRanAt[0]).not.toHaveProperty('stderrTailBytes');

    const attempt = persistedTasks.tasks[0]?.attempts[0];
    expect(attempt?.checkRuns).toBeUndefined();
    expect(attempt?.verifyRuns).toBeDefined();
    expect(attempt?.verifyRuns?.[0]).not.toHaveProperty('stdoutTailBytes');
  });
});
