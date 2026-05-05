// Legacy intent: src/business/pipelines/*.test.ts step-order + failure path coverage
import { describe, expect, it } from 'vitest';

import type { EvaluationSignal } from '@src/domain/signals/harness-signal.ts';
import { FakeAiSessionPort } from '@src/business/_test-fakes/fake-ai-session-port.ts';
import { FakeLoggerPort } from '@src/business/_test-fakes/fake-logger-port.ts';
import { FakeWriteContextFilePort } from '@src/business/_test-fakes/fake-write-context-file-port.ts';
import type { WriteContextFilePort } from '@src/business/ports/write-context-file-port.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { unitSlug } from '@src/integration/persistence/unit-slug.ts';
import { T0, abs, makeSprint, makeTask, taskId } from '@src/application/_test-fakes/fixtures.ts';
import { createTestDeps } from '@src/application/_test-fakes/create-test-deps.ts';
import { createEvaluateFlow } from './evaluate-flow.ts';

const CWD = abs('/tmp/evaluate-test');

const passSignal: EvaluationSignal = {
  type: 'evaluation',
  status: 'passed',
  dimensions: [
    { dimension: 'correctness', score: 5, passed: true, finding: 'ok' },
    { dimension: 'completeness', score: 4, passed: true, finding: 'ok' },
  ],
  overallScore: 4.5,
  critique: 'lgtm',
  timestamp: '2026-04-29T12:00:00Z' as never,
};

function activateSprint(draft: ReturnType<typeof makeSprint>) {
  const activated = draft.activate(T0);
  if (!activated.ok) throw new Error(`activateSprint: ${activated.error.message}`);
  return activated.value;
}

describe('createEvaluateFlow', () => {
  it('runs load-sprint → assert-active → load-task → render-prompt-to-file → evaluate-task → persist-evaluation', async () => {
    const sprint = activateSprint(makeSprint());
    const task = makeTask({ name: 'do thing' });
    const deps = createTestDeps({
      sprints: [sprint],
      tasks: [[sprint.id, [task]]],
      aiSession: { outcomes: [{ kind: 'ok', result: { output: 'evaluator output' } }] },
      signalParser: { results: [[passSignal]] },
    });

    const flow = createEvaluateFlow(deps);

    const result = await flow.execute({
      sprintId: sprint.id,
      taskId: task.id,
      cwd: CWD,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.trace.map((t) => t.stepName)).toStrictEqual([
      'load-sprint',
      'assert-active',
      'load-task',
      'render-prompt-to-file',
      'evaluate-task',
      'persist-evaluation',
    ]);

    // Task got the evaluation recorded.
    const reread = await deps.taskRepo.findById(sprint.id, task.id);
    if (!reread.ok) throw new Error('expected task');
    expect(reread.value.evaluated).toBe(true);
    expect(reread.value.evaluationStatus).toBe('passed');
  });

  it('step short-circuit: mid-chain leaf error skips remaining steps with "skipped" status', async () => {
    // Force a real failure mid-chain by feeding load-task a missing taskId
    // so the chain aborts before evaluate-task runs.
    const sprint = activateSprint(makeSprint());
    const deps = createTestDeps({
      sprints: [sprint],
      // No tasks registered → load-task fails with NotFoundError.
      tasks: [],
    });

    // Use a synthesised TaskId that won't resolve.
    const phantom = makeTask({ name: 'phantom' });
    const flow = createEvaluateFlow(deps);

    const result = await flow.execute({
      sprintId: sprint.id,
      taskId: phantom.id,
      cwd: CWD,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Steps after the failing one must appear as 'skipped'.
    const skipped = result.error.trace.filter((t) => t.status === 'skipped');
    expect(skipped.length).toBeGreaterThan(0);
    // The failing step itself is 'failed'.
    const failed = result.error.trace.find((t) => t.status === 'failed');
    expect(failed).toBeDefined();
    expect(failed?.stepName).toBe('load-task');
  });

  it('abort propagation: pre-aborted signal marks in-flight step "aborted" and remainder "skipped"', async () => {
    const sprint = activateSprint(makeSprint());
    const task = makeTask({ name: 'do thing' });
    const deps = createTestDeps({
      sprints: [sprint],
      tasks: [[sprint.id, [task]]],
    });

    const flow = createEvaluateFlow(deps);

    const ac = new AbortController();
    ac.abort();

    const result = await flow.execute({ sprintId: sprint.id, taskId: task.id, cwd: CWD }, ac.signal);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe('aborted');
    // At least one trace entry must be 'aborted'.
    expect(result.error.trace.some((t) => t.status === 'aborted')).toBe(true);
  });

  it('re-runs end-to-end when the task is already evaluated (re-runs are allowed)', async () => {
    // The evaluator never blocks (REQUIREMENTS.md). Re-running
    // `sprint evaluate <task>` on a task that already has a recorded
    // verdict must complete successfully — and now runs the AI spawn
    // again so a stale verdict can be refreshed. Each invocation lays
    // down a fresh `rounds/standalone-<ISO>/` so prior verdicts persist
    // as durable history.
    const sprint = activateSprint(makeSprint());
    const task0 = makeTask({ name: 'do thing' });
    const evaluated = task0.recordEvaluation({
      status: 'passed',
      output: 'prior critique',
      file: 'execution/x/latest-evaluation.md',
    });

    const aiSession = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: 'fresh evaluator output' } }],
    });
    const writeContextFile = new FakeWriteContextFilePort();
    const deps = createTestDeps({
      sprints: [sprint],
      tasks: [[sprint.id, [evaluated]]],
      signalParser: { results: [[passSignal]] },
      overrides: { aiSession, writeContextFile },
    });

    const flow = createEvaluateFlow(deps);

    const result = await flow.execute({
      sprintId: sprint.id,
      taskId: evaluated.id,
      cwd: CWD,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.trace.map((t) => t.stepName)).toStrictEqual([
      'load-sprint',
      'assert-active',
      'load-task',
      'render-prompt-to-file',
      'evaluate-task',
      'persist-evaluation',
    ]);
    // A fresh AI spawn fires — the chain no longer short-circuits.
    expect(aiSession.captured).toHaveLength(1);
    // Two writes routed via WriteContextFilePort: the rendered prompt
    // and the per-round evaluation.md verdict — both under the
    // standalone-round folder. Each round path is unique, so no
    // pointer file is needed.
    expect(writeContextFile.writes).toHaveLength(2);
    const writtenPaths = writeContextFile.writes.map((w) => String(w.path));
    expect(writtenPaths).toStrictEqual(
      expect.arrayContaining([
        expect.stringMatching(/\/execution\/[^/]+\/rounds\/standalone-[^/]+\/evaluator\/prompt\.md$/),
        expect.stringMatching(/\/execution\/[^/]+\/rounds\/standalone-[^/]+\/evaluator\/evaluation\.md$/),
      ])
    );
  });

  it('fails on assert-active when sprint is not active (draft)', async () => {
    // A draft sprint must be rejected by assert-active before any task
    // lookup or AI session fires. The guard is the second step in the
    // chain (index 1); no step at index 2 or beyond should run as a
    // non-skipped entry.
    const sprint = makeSprint(); // status: 'draft'
    const task = makeTask({ name: 'do thing' });
    const deps = createTestDeps({
      sprints: [sprint],
      tasks: [[sprint.id, [task]]],
    });

    const flow = createEvaluateFlow(deps);

    const result = await flow.execute({
      sprintId: sprint.id,
      taskId: task.id,
      cwd: CWD,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    // assert-active is trace index 1 (load-sprint is 0).
    expect(result.error.trace[1]?.stepName).toBe('assert-active');
    expect(result.error.trace[1]?.status).toBe('failed');
    // Every step after assert-active must appear as 'skipped' — no AI
    // session or task lookup fired.
    const assertActiveIdx = result.error.trace.findIndex((t) => t.stepName === 'assert-active');
    const stepsAfter = result.error.trace.slice(assertActiveIdx + 1);
    expect(stepsAfter.every((t) => t.status === 'skipped')).toBe(true);
    // The error code must identify the state violation.
    expect(result.error.error.code).toBe('invalid-state');
  });

  it('two same-process invocations land in distinct rounds/standalone-<ISO>/ folders', async () => {
    // Each `createEvaluateFlow(...)` call captures its own folder token
    // (`<ISO>-<rand4>`). The 4-char random suffix means two back-to-back
    // factory calls land in distinct folders even within the same
    // millisecond — no `setTimeout` needed in this test, no race in
    // production.
    const sprint = activateSprint(makeSprint());
    const task = makeTask({ name: 'do thing' });

    const aiSession1 = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: 'evaluator output 1' } }],
    });
    const writer1 = new FakeWriteContextFilePort();
    const deps1 = createTestDeps({
      sprints: [sprint],
      tasks: [[sprint.id, [task]]],
      signalParser: { results: [[passSignal]] },
      overrides: { aiSession: aiSession1, writeContextFile: writer1 },
    });
    const flow1 = createEvaluateFlow(deps1);

    const result1 = await flow1.execute({ sprintId: sprint.id, taskId: task.id, cwd: CWD });
    expect(result1.ok).toBe(true);

    const aiSession2 = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: 'evaluator output 2' } }],
    });
    const writer2 = new FakeWriteContextFilePort();
    const deps2 = createTestDeps({
      sprints: [sprint],
      tasks: [[sprint.id, [task]]],
      signalParser: { results: [[passSignal]] },
      overrides: { aiSession: aiSession2, writeContextFile: writer2 },
    });
    const flow2 = createEvaluateFlow(deps2);

    const result2 = await flow2.execute({ sprintId: sprint.id, taskId: task.id, cwd: CWD });
    expect(result2.ok).toBe(true);

    const folder1 = extractStandaloneFolder(writer1.writes.map((w) => String(w.path)));
    const folder2 = extractStandaloneFolder(writer2.writes.map((w) => String(w.path)));
    expect(folder1).toBeDefined();
    expect(folder2).toBeDefined();
    expect(folder1).not.toBe(folder2);
  });

  it('persists Task.evaluationFile as execution/<unit-slug>/rounds/standalone-<ISO>/evaluator/evaluation.md', async () => {
    // The persisted relative path must point at the verdict file the
    // upstream evaluate-task leaf actually wrote — keyed on the unit
    // slug (`<id>-<name-slug>`) and the standalone round's ISO. Each
    // standalone-round path is unique, so the recorded value
    // unambiguously locates THIS run's verdict — no pointer-file
    // indirection, no stale references after a re-run.
    const sprint = activateSprint(makeSprint());
    const explicitId = taskId('abc123');
    const task = makeTask({ id: explicitId, name: 'My Cool Feature' });

    const deps = createTestDeps({
      sprints: [sprint],
      tasks: [[sprint.id, [task]]],
      aiSession: { outcomes: [{ kind: 'ok', result: { output: 'evaluator output' } }] },
      signalParser: { results: [[passSignal]] },
    });

    const flow = createEvaluateFlow(deps);
    const result = await flow.execute({ sprintId: sprint.id, taskId: task.id, cwd: CWD });
    expect(result.ok).toBe(true);

    const reread = await deps.taskRepo.findById(sprint.id, task.id);
    if (!reread.ok) throw new Error('expected task');

    const slug = unitSlug(String(task.id), task.name);
    expect(slug).toBe('abc123-my-cool-feature');
    expect(reread.value.evaluationFile).toMatch(
      new RegExp(`^execution/${slug}/rounds/standalone-[^/]+/evaluator/evaluation\\.md$`)
    );
  });

  it('standalone evaluate write failures warn and never block the chain', async () => {
    // Inject a fake writer that fails specifically on the verdict path
    // but lets the prompt write succeed. The chain must complete
    // (Result.ok) and emit a warn-level diagnostic referencing the
    // failed path — durable history is best-effort, and the in-memory
    // critique still flows downstream to persist-evaluation.
    const sprint = activateSprint(makeSprint());
    const task = makeTask({ name: 'do thing' });

    const writer: WriteContextFilePort = {
      writes: [] as { path: AbsolutePath; content: string }[],
      write(path, content) {
        this.writes.push({ path, content });
        const p = String(path);
        if (p.endsWith('/evaluation.md')) {
          return Promise.resolve(
            Result.error(new StorageError({ subCode: 'io', message: 'EACCES simulated', path: p }))
          );
        }
        return Promise.resolve(Result.ok());
      },
    } as WriteContextFilePort & { writes: { path: AbsolutePath; content: string }[] };

    const logger = new FakeLoggerPort();
    const deps = createTestDeps({
      sprints: [sprint],
      tasks: [[sprint.id, [task]]],
      aiSession: { outcomes: [{ kind: 'ok', result: { output: 'evaluator output' } }] },
      signalParser: { results: [[passSignal]] },
      overrides: { writeContextFile: writer, logger },
    });

    const flow = createEvaluateFlow(deps);
    const result = await flow.execute({ sprintId: sprint.id, taskId: task.id, cwd: CWD });

    expect(result.ok).toBe(true);

    // At least one warn log references the failed evaluation.md path.
    const warns = logger.entries.filter((e) => e.level === 'warn');
    expect(warns.length).toBeGreaterThanOrEqual(1);
    const warnedPaths = warns
      .map((w) => (typeof w.context['path'] === 'string' ? w.context['path'] : ''))
      .filter((p) => p.length > 0);
    expect(warnedPaths.some((p) => p.endsWith('/evaluation.md'))).toBe(true);

    // Persist-evaluation still ran with the in-memory critique.
    const reread = await deps.taskRepo.findById(sprint.id, task.id);
    if (!reread.ok) throw new Error('expected task');
    expect(reread.value.evaluated).toBe(true);
  });
});

/**
 * Extract the `rounds/standalone-<iso>/` segment from any of the per-run
 * write paths. Returns `undefined` when no path matches, which the test
 * assertion catches.
 */
function extractStandaloneFolder(paths: readonly string[]): string | undefined {
  const re = /\/(rounds\/standalone-[^/]+)\//;
  for (const p of paths) {
    const m = re.exec(p);
    if (m && typeof m[1] === 'string') return m[1];
  }
  return undefined;
}
