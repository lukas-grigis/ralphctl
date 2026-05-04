import { describe, expect, it } from 'vitest';

import { Sprint } from '@src/domain/entities/sprint.ts';
import { Task } from '@src/domain/entities/task.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import type { TaskBlockedSignal, TaskCompleteSignal } from '@src/domain/signals/harness-signal.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { Slug } from '@src/domain/values/slug.ts';
import { FakeAiSessionPort } from '@src/business/_test-fakes/fake-ai-session-port.ts';
import { FakeLoggerPort } from '@src/business/_test-fakes/fake-logger-port.ts';
import { FakeSignalBusPort } from '@src/business/_test-fakes/fake-signal-bus-port.ts';
import { FakeSignalParserPort } from '@src/business/_test-fakes/fake-signal-parser-port.ts';
import { RateLimitCoordinator } from '@src/kernel/algorithms/rate-limit-coordinator.ts';
import { ExecuteSingleTaskUseCase } from './execute-single-task.ts';

interface TaskCreationOpts {
  readonly name?: string;
}

const T0 = '2026-04-29T14:15:22.000Z' as IsoTimestamp;

function path(p: string): AbsolutePath {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function slug(s: string): Slug {
  const r = Slug.parse(s);
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function projectName(): ProjectName {
  const r = ProjectName.parse('demo');
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function aSprint(): Sprint {
  const s = Sprint.create({ name: 'A', slug: slug('a'), now: T0, projectName: projectName() });
  if (!s.ok) throw new Error('precondition failed');
  return s.value;
}

function aTask(opts: TaskCreationOpts = {}): Task {
  const t = Task.create({
    name: opts.name ?? 'do something',
    steps: [],
    verificationCriteria: [],
    order: 1,
    projectPath: path('/repos/demo'),
  });
  if (!t.ok) throw new Error('precondition failed');
  return t.value;
}

function completeSignal(): TaskCompleteSignal {
  return { type: 'task-complete', timestamp: T0 };
}

/** Canonical context-file path used by every test in this file. */
const CONTEXT_FILE = '/tmp/sprints/a/contexts/task.md';

function blockedSignal(reason = 'unsafe'): TaskBlockedSignal {
  return { type: 'task-blocked', reason, timestamp: T0 };
}

describe('ExecuteSingleTaskUseCase', () => {
  it('returns completed when the AI emits task-complete', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: 'ok', sessionId: 'sess-1' } }],
    });
    const parser = new FakeSignalParserPort({ results: [[completeSignal()]] });
    const uc = new ExecuteSingleTaskUseCase(ai, parser, new FakeLoggerPort());

    const result = await uc.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      promptFilePath: CONTEXT_FILE,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('completed');
    expect(result.value.signals).toHaveLength(1);
    expect(result.value.newSessionId).toBe('sess-1');
  });

  it('returns failed when no completion signal is emitted', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: 'no signals here' } }],
    });
    const parser = new FakeSignalParserPort({ results: [[]] });
    const uc = new ExecuteSingleTaskUseCase(ai, parser, new FakeLoggerPort());

    const result = await uc.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      promptFilePath: CONTEXT_FILE,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('failed');
    expect(result.value.reason).toBe('task did not signal completion');
  });

  it('returns blocked when a task-blocked signal is found', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: 'blocked', sessionId: 's2' } }],
    });
    const parser = new FakeSignalParserPort({
      results: [[blockedSignal('missing creds')]],
    });
    const uc = new ExecuteSingleTaskUseCase(ai, parser, new FakeLoggerPort());

    const result = await uc.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      promptFilePath: CONTEXT_FILE,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('blocked');
    expect(result.value.reason).toBe('missing creds');
    expect(result.value.newSessionId).toBe('s2');
  });

  it('returns rate-limited when spawn fails with a rate-limit message', async () => {
    const error = new StorageError({
      subCode: 'io',
      message: 'spawn failed: 429 too many requests',
    });
    const ai = new FakeAiSessionPort({ outcomes: [{ kind: 'error', error }] });
    const uc = new ExecuteSingleTaskUseCase(ai, new FakeSignalParserPort(), new FakeLoggerPort());

    const result = await uc.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      promptFilePath: CONTEXT_FILE,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('rate-limited');
    expect(result.value.rateLimitedAt).toBeDefined();
    expect(result.value.signals).toHaveLength(0);
  });

  it('propagates non-rate-limit spawn failures as Result.error', async () => {
    const error = new StorageError({
      subCode: 'io',
      message: 'spawn failed: ENOENT',
    });
    const ai = new FakeAiSessionPort({ outcomes: [{ kind: 'error', error }] });
    const uc = new ExecuteSingleTaskUseCase(ai, new FakeSignalParserPort(), new FakeLoggerPort());

    const result = await uc.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      promptFilePath: CONTEXT_FILE,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('storage-error');
    }
  });

  it('uses resumeSession when resumeSessionId is provided', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: 'resumed', sessionId: 'after' } }],
    });
    const parser = new FakeSignalParserPort({ results: [[completeSignal()]] });
    const uc = new ExecuteSingleTaskUseCase(ai, parser, new FakeLoggerPort());

    const result = await uc.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      promptFilePath: CONTEXT_FILE,
      resumeSessionId: 'old-session',
    });

    expect(result.ok).toBe(true);
    expect(ai.captured).toHaveLength(1);
    expect(ai.captured[0]?.options.resumeSessionId).toBe('old-session');
  });

  it('forwards the abort signal to the AI session', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: '' } }],
    });
    const parser = new FakeSignalParserPort({ results: [[]] });
    const uc = new ExecuteSingleTaskUseCase(ai, parser, new FakeLoggerPort());
    const ac = new AbortController();

    await uc.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      promptFilePath: CONTEXT_FILE,
      abortSignal: ac.signal,
    });

    expect(ai.captured[0]?.options.abortSignal).toBe(ac.signal);
  });

  it('empty stdout produces outcome "failed" with no signals', async () => {
    // Legacy intent: src/business/usecases/execute.ts empty-output path
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: '' } }],
    });
    const parser = new FakeSignalParserPort({ results: [[]] });
    const uc = new ExecuteSingleTaskUseCase(ai, parser, new FakeLoggerPort());

    const result = await uc.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      promptFilePath: CONTEXT_FILE,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('failed');
    expect(result.value.signals).toHaveLength(0);
  });

  it('multiple task-blocked signals: outcome is "blocked" and all signals are captured', async () => {
    // Legacy intent: src/business/usecases/execute.ts multiple-blocked-signals path
    const block1 = blockedSignal('needs creds');
    const block2 = blockedSignal('service unavailable');
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: 'blocked twice' } }],
    });
    const parser = new FakeSignalParserPort({ results: [[block1, block2]] });
    const uc = new ExecuteSingleTaskUseCase(ai, parser, new FakeLoggerPort());

    const result = await uc.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      promptFilePath: CONTEXT_FILE,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('blocked');
    // First blocked reason is used, but all signals are in the array.
    expect(result.value.signals).toHaveLength(2);
    expect(result.value.reason).toBe('needs creds');
  });

  it('task-verified followed by task-complete: outcome is "completed"', async () => {
    // Legacy intent: src/business/usecases/execute.ts task-verified + task-complete combination
    const verified = { type: 'task-verified' as const, output: 'all green', timestamp: T0 };
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: 'verified and done' } }],
    });
    const parser = new FakeSignalParserPort({ results: [[verified, completeSignal()]] });
    const uc = new ExecuteSingleTaskUseCase(ai, parser, new FakeLoggerPort());

    const result = await uc.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      promptFilePath: CONTEXT_FILE,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('completed');
    expect(result.value.signals).toHaveLength(2);
  });

  it('task-complete without preceding task-verified: outcome is still "completed"', async () => {
    // Legacy intent: verify task-complete alone is sufficient; task-verified is not required.
    // This documents the behavior: the use case classifies by task-complete presence, not verified.
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: 'done without verify' } }],
    });
    const parser = new FakeSignalParserPort({ results: [[completeSignal()]] });
    const uc = new ExecuteSingleTaskUseCase(ai, parser, new FakeLoggerPort());

    const result = await uc.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      promptFilePath: CONTEXT_FILE,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // task-complete alone is sufficient for 'completed' outcome
    expect(result.value.outcome).toBe('completed');
  });

  it('logs the task id and a name slice so parallel tasks are distinguishable', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: 'done' } }],
    });
    const parser = new FakeSignalParserPort({ results: [[completeSignal()]] });
    const logger = new FakeLoggerPort();
    const uc = new ExecuteSingleTaskUseCase(ai, parser, logger);

    const task = aTask({ name: 'wire up the auth middleware' });

    await uc.execute({
      task,
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      promptFilePath: CONTEXT_FILE,
    });

    const executing = logger.entries.find((e) => e.message.startsWith('executing task '));
    expect(executing).toBeDefined();
    expect(executing?.message).toContain(String(task.id));
    expect(executing?.message).toContain('wire up the auth middleware');
  });

  it('clips long task names in the log message', async () => {
    const longName = 'a'.repeat(80);
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: 'done' } }],
    });
    const parser = new FakeSignalParserPort({ results: [[completeSignal()]] });
    const logger = new FakeLoggerPort();
    const uc = new ExecuteSingleTaskUseCase(ai, parser, logger);

    await uc.execute({
      task: aTask({ name: longName }),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      promptFilePath: CONTEXT_FILE,
    });

    const executing = logger.entries.find((e) => e.message.startsWith('executing task '));
    expect(executing).toBeDefined();
    // 50-char slice + ellipsis, not the full 80-char string.
    expect(executing?.message).toContain('…');
    expect(executing?.message).not.toContain('a'.repeat(80));
  });

  it('preserves all parsed signals in emission order', async () => {
    const note = {
      type: 'note' as const,
      text: 'fyi',
      timestamp: T0,
    };
    const verified = {
      type: 'task-verified' as const,
      output: 'all green',
      timestamp: T0,
    };
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: 'mixed' } }],
    });
    const parser = new FakeSignalParserPort({
      results: [[note, verified, completeSignal()]],
    });
    const uc = new ExecuteSingleTaskUseCase(ai, parser, new FakeLoggerPort());

    const result = await uc.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      promptFilePath: CONTEXT_FILE,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('completed');
    expect(result.value.signals.map((s) => s.type)).toStrictEqual(['note', 'task-verified', 'task-complete']);
  });

  it('emits every parsed signal on the signal bus, tagged with sprintId + taskId', async () => {
    const note = { type: 'note' as const, text: 'fyi', timestamp: T0 };
    const verified = { type: 'task-verified' as const, output: 'green', timestamp: T0 };
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: 'streamed' } }],
    });
    const parser = new FakeSignalParserPort({
      results: [[note, verified, completeSignal()]],
    });
    const bus = new FakeSignalBusPort();
    const uc = new ExecuteSingleTaskUseCase(ai, parser, new FakeLoggerPort(), bus);

    const sprint = aSprint();
    const task = aTask();
    const result = await uc.execute({
      task,
      sprint,
      cwd: path('/repos/demo'),
      promptFilePath: CONTEXT_FILE,
    });

    expect(result.ok).toBe(true);

    // One emission per parsed signal, in emission order, all tagged.
    expect(bus.events.map((e) => (e.type === 'signal' ? e.signal.type : e.type))).toStrictEqual([
      'note',
      'task-verified',
      'task-complete',
    ]);
    for (const e of bus.events) {
      if (e.type === 'signal') {
        expect(e.sprintId).toBe(sprint.id);
        expect(e.taskId).toBe(task.id);
      }
    }
  });

  it('pauses the rate-limit coordinator when the spawn surfaces a 429 hint', async () => {
    const error = new StorageError({
      subCode: 'io',
      message: 'spawn failed: 429 too many requests',
    });
    const ai = new FakeAiSessionPort({ outcomes: [{ kind: 'error', error }] });
    const coordinator = new RateLimitCoordinator();
    const uc = new ExecuteSingleTaskUseCase(
      ai,
      new FakeSignalParserPort(),
      new FakeLoggerPort(),
      undefined,
      coordinator
    );

    const result = await uc.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      promptFilePath: CONTEXT_FILE,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('rate-limited');
    expect(coordinator.isPaused()).toBe(true);
  });

  it('does not emit signals or call coordinator when neither is provided', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: 'done' } }],
    });
    const parser = new FakeSignalParserPort({ results: [[completeSignal()]] });
    // No bus, no coordinator — verifies the use case stays optional-friendly.
    const uc = new ExecuteSingleTaskUseCase(ai, parser, new FakeLoggerPort());

    const result = await uc.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      promptFilePath: CONTEXT_FILE,
    });

    expect(result.ok).toBe(true);
  });
});
