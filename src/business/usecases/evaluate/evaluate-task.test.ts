import { describe, expect, it } from 'vitest';

import { Sprint } from '@src/domain/entities/sprint.ts';
import { Task } from '@src/domain/entities/task.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import type { EvaluationSignal } from '@src/domain/signals/harness-signal.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { Slug } from '@src/domain/values/slug.ts';
import { FakeAiSessionPort } from '@src/business/_test-fakes/fake-ai-session-port.ts';
import { FakeLoggerPort } from '@src/business/_test-fakes/fake-logger-port.ts';
import { FakePromptBuilderPort } from '@src/business/_test-fakes/fake-prompt-builder-port.ts';
import { FakeSignalParserPort } from '@src/business/_test-fakes/fake-signal-parser-port.ts';
import { EvaluateTaskUseCase } from './evaluate-task.ts';

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

function aTask(): Task {
  const t = Task.create({
    name: 'do thing',
    steps: [],
    verificationCriteria: [],
    order: 1,
    projectPath: path('/repos/demo'),
  });
  if (!t.ok) throw new Error('precondition failed');
  return t.value;
}

function passedSignal(): EvaluationSignal {
  return {
    type: 'evaluation',
    status: 'passed',
    dimensions: [{ dimension: 'correctness', passed: true, finding: 'ok' }],
    timestamp: T0,
  };
}

function failedSignal(): EvaluationSignal {
  return {
    type: 'evaluation',
    status: 'failed',
    dimensions: [{ dimension: 'safety', passed: false, finding: 'leak' }],
    critique: 'fix the leak',
    timestamp: T0,
  };
}

describe('EvaluateTaskUseCase', () => {
  it('returns passed when the evaluator signals passed', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: 'passed' } }],
    });
    const parser = new FakeSignalParserPort({ results: [[passedSignal()]] });
    const uc = new EvaluateTaskUseCase(ai, new FakePromptBuilderPort(), parser, new FakeLoggerPort());

    const result = await uc.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('passed');
    expect(result.value.signal.status).toBe('passed');
    expect(result.value.fullCritique).toBe('passed');
  });

  it('returns failed when the evaluator signals failed', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: 'critique body' } }],
    });
    const parser = new FakeSignalParserPort({ results: [[failedSignal()]] });
    const uc = new EvaluateTaskUseCase(ai, new FakePromptBuilderPort(), parser, new FakeLoggerPort());

    const result = await uc.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('failed');
    expect(result.value.signal.dimensions).toHaveLength(1);
  });

  it('synthesises a malformed signal when no EvaluationSignal is parsed', async () => {
    const longOutput = 'x'.repeat(800);
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: longOutput } }],
    });
    const parser = new FakeSignalParserPort({ results: [[]] });
    const logger = new FakeLoggerPort();
    const uc = new EvaluateTaskUseCase(ai, new FakePromptBuilderPort(), parser, logger);

    const result = await uc.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('malformed');
    expect(result.value.signal.status).toBe('malformed');
    expect(result.value.signal.dimensions).toHaveLength(0);
    expect(result.value.signal.critique?.length).toBe(500);
    expect(result.value.fullCritique).toBe(longOutput);
    expect(logger.hasMessage('warn', 'malformed')).toBe(true);
  });

  it('evaluation-failed signal with empty critique is treated as failed outcome', async () => {
    // Legacy intent: src/business/usecases/evaluate.ts whitespace-only evaluation-failed
    // The parser converts whitespace-only content to empty string; a failed signal
    // with no critique text is still a valid failed outcome (not malformed) when
    // dimensions are present.
    const failedEmptyCritique: EvaluationSignal = {
      type: 'evaluation',
      status: 'failed',
      dimensions: [{ dimension: 'correctness', passed: false, finding: 'incomplete' }],
      critique: '',
      timestamp: T0,
    };
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: '<evaluation-failed>   </evaluation-failed>' } }],
    });
    const parser = new FakeSignalParserPort({ results: [[failedEmptyCritique]] });
    const uc = new EvaluateTaskUseCase(ai, new FakePromptBuilderPort(), parser, new FakeLoggerPort());

    const result = await uc.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('failed');
    // The critique from the signal is empty but it's still a valid failed evaluation.
    expect(result.value.signal.status).toBe('failed');
    expect(result.value.signal.dimensions).toHaveLength(1);
  });

  it('threads previousCritique into the prompt builder for re-evaluation', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: 'pass' } }],
    });
    const parser = new FakeSignalParserPort({ results: [[passedSignal()]] });
    const prompts = new FakePromptBuilderPort();
    const uc = new EvaluateTaskUseCase(ai, prompts, parser, new FakeLoggerPort());

    await uc.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      previousCritique: 'last round said: fix the safety issue',
    });

    expect(prompts.evaluateCalls).toHaveLength(1);
    expect(prompts.evaluateCalls[0]?.previousCritique).toBe('last round said: fix the safety issue');
  });

  it('propagates spawn failures as Result.error', async () => {
    const failure = new StorageError({ subCode: 'io', message: 'spawn died' });
    const ai = new FakeAiSessionPort({ outcomes: [{ kind: 'error', error: failure }] });
    const uc = new EvaluateTaskUseCase(
      ai,
      new FakePromptBuilderPort(),
      new FakeSignalParserPort(),
      new FakeLoggerPort()
    );

    const result = await uc.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('storage-error');
    }
  });

  it('propagates a prompt-builder failure', async () => {
    const failure = new StorageError({ subCode: 'io', message: 'template missing' });
    const prompts = new FakePromptBuilderPort({ failWith: failure });
    const ai = new FakeAiSessionPort();
    const uc = new EvaluateTaskUseCase(ai, prompts, new FakeSignalParserPort(), new FakeLoggerPort());

    const result = await uc.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
    });

    expect(result.ok).toBe(false);
    expect(ai.captured).toHaveLength(0);
  });

  it('logs the task id and a name slice so parallel evaluations are distinguishable', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: 'pass' } }],
    });
    const parser = new FakeSignalParserPort({ results: [[passedSignal()]] });
    const logger = new FakeLoggerPort();
    const uc = new EvaluateTaskUseCase(ai, new FakePromptBuilderPort(), parser, logger);

    const task = aTask();

    await uc.execute({
      task,
      sprint: aSprint(),
      cwd: path('/repos/demo'),
    });

    const evaluating = logger.entries.find((e) => e.message.startsWith('evaluating task '));
    expect(evaluating).toBeDefined();
    expect(evaluating?.message).toContain(String(task.id));
    expect(evaluating?.message).toContain('do thing');
  });

  it('forwards the abort signal to the AI session', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: '' } }],
    });
    const parser = new FakeSignalParserPort({ results: [[passedSignal()]] });
    const uc = new EvaluateTaskUseCase(ai, new FakePromptBuilderPort(), parser, new FakeLoggerPort());
    const ac = new AbortController();

    await uc.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      abortSignal: ac.signal,
    });

    expect(ai.captured[0]?.options.abortSignal).toBe(ac.signal);
  });
});
