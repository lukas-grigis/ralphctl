import { describe, expect, it } from 'vitest';

import { Sprint } from '../../../domain/entities/sprint.ts';
import { StorageError } from '../../../domain/errors/storage-error.ts';
import type { NoteSignal } from '../../../domain/signals/harness-signal.ts';
import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { IsoTimestamp } from '../../../domain/values/iso-timestamp.ts';
import { Slug } from '../../../domain/values/slug.ts';
import { FakeAiSessionPort } from '../../_test-fakes/fake-ai-session-port.ts';
import { FakeLoggerPort } from '../../_test-fakes/fake-logger-port.ts';
import { FakePromptBuilderPort } from '../../_test-fakes/fake-prompt-builder-port.ts';
import { FakeSignalParserPort } from '../../_test-fakes/fake-signal-parser-port.ts';
import { ApplyFeedbackUseCase } from './apply-feedback.ts';

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

function aSprint(): Sprint {
  const s = Sprint.create({ name: 'A', slug: slug('a'), now: T0 });
  if (!s.ok) throw new Error('precondition failed');
  return s.value;
}

function note(text: string): NoteSignal {
  return { type: 'note', text, timestamp: T0 };
}

describe('ApplyFeedbackUseCase', () => {
  it('returns an empty envelope when feedback is empty (no AI spawn)', async () => {
    const ai = new FakeAiSessionPort();
    const prompts = new FakePromptBuilderPort();
    const uc = new ApplyFeedbackUseCase(ai, prompts, new FakeSignalParserPort(), new FakeLoggerPort());

    const result = await uc.execute({
      sprint: aSprint(),
      feedbackText: '',
      cwd: path('/repos/demo'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.signals).toHaveLength(0);
    expect(result.value.rawAiOutput).toBe('');
    expect(ai.captured).toHaveLength(0);
    expect(prompts.feedbackCalls).toHaveLength(0);
  });

  it('treats whitespace-only feedback as empty', async () => {
    const ai = new FakeAiSessionPort();
    const uc = new ApplyFeedbackUseCase(
      ai,
      new FakePromptBuilderPort(),
      new FakeSignalParserPort(),
      new FakeLoggerPort()
    );

    const result = await uc.execute({
      sprint: aSprint(),
      feedbackText: '   \n\t  ',
      cwd: path('/repos/demo'),
    });

    expect(result.ok).toBe(true);
    expect(ai.captured).toHaveLength(0);
  });

  it('spawns AI and returns parsed signals on non-empty feedback', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: 'applied' } }],
    });
    const parser = new FakeSignalParserPort({
      results: [[note('did the thing')]],
    });
    const uc = new ApplyFeedbackUseCase(ai, new FakePromptBuilderPort(), parser, new FakeLoggerPort());

    const result = await uc.execute({
      sprint: aSprint(),
      feedbackText: 'tighten the spinner labels',
      cwd: path('/repos/demo'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.signals).toHaveLength(1);
    expect(result.value.signals[0]?.type).toBe('note');
    expect(result.value.rawAiOutput).toBe('applied');
  });

  it('passes the feedback text through to the prompt builder', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: '' } }],
    });
    const prompts = new FakePromptBuilderPort();
    const uc = new ApplyFeedbackUseCase(ai, prompts, new FakeSignalParserPort({ results: [[]] }), new FakeLoggerPort());

    await uc.execute({
      sprint: aSprint(),
      feedbackText: 'add tests for X',
      cwd: path('/repos/demo'),
    });

    expect(prompts.feedbackCalls).toHaveLength(1);
    expect(prompts.feedbackCalls[0]?.feedbackText).toBe('add tests for X');
  });

  it('propagates spawn failure', async () => {
    const failure = new StorageError({ subCode: 'io', message: 'spawn died' });
    const ai = new FakeAiSessionPort({ outcomes: [{ kind: 'error', error: failure }] });
    const uc = new ApplyFeedbackUseCase(
      ai,
      new FakePromptBuilderPort(),
      new FakeSignalParserPort(),
      new FakeLoggerPort()
    );

    const result = await uc.execute({
      sprint: aSprint(),
      feedbackText: 'do X',
      cwd: path('/repos/demo'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('storage-error');
    }
  });

  it('propagates a prompt-builder failure without spawning', async () => {
    const failure = new StorageError({ subCode: 'io', message: 'template missing' });
    const prompts = new FakePromptBuilderPort({ failWith: failure });
    const ai = new FakeAiSessionPort();
    const uc = new ApplyFeedbackUseCase(ai, prompts, new FakeSignalParserPort(), new FakeLoggerPort());

    const result = await uc.execute({
      sprint: aSprint(),
      feedbackText: 'do X',
      cwd: path('/repos/demo'),
    });

    expect(result.ok).toBe(false);
    expect(ai.captured).toHaveLength(0);
  });

  it('forwards the abort signal to the AI session', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: '' } }],
    });
    const uc = new ApplyFeedbackUseCase(
      ai,
      new FakePromptBuilderPort(),
      new FakeSignalParserPort({ results: [[]] }),
      new FakeLoggerPort()
    );
    const ac = new AbortController();

    await uc.execute({
      sprint: aSprint(),
      feedbackText: 'do something',
      cwd: path('/repos/demo'),
      abortSignal: ac.signal,
    });

    expect(ai.captured[0]?.options.abortSignal).toBe(ac.signal);
  });
});
