import { describe, expect, it } from 'vitest';

import { Sprint } from '@src/domain/entities/sprint.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import type { NoteSignal } from '@src/domain/signals/harness-signal.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { Slug } from '@src/domain/values/slug.ts';
import { FakeAiSessionPort } from '@src/business/_test-fakes/fake-ai-session-port.ts';
import { FakeLoggerPort } from '@src/business/_test-fakes/fake-logger-port.ts';
import { FakeSignalBusPort } from '@src/business/_test-fakes/fake-signal-bus-port.ts';
import { FakeSignalParserPort } from '@src/business/_test-fakes/fake-signal-parser-port.ts';
import { ApplyFeedbackUseCase } from './apply-feedback.ts';

const T0 = '2026-04-29T14:15:22.000Z' as IsoTimestamp;
/** Canonical prompt-file path used by every test in this file. */
const PROMPT_FILE = '/tmp/sprints/a/contexts/feedback-1.md';

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

function note(text: string): NoteSignal {
  return { type: 'note', text, timestamp: T0 };
}

describe('ApplyFeedbackUseCase', () => {
  it('spawns AI with the file-handoff wrapper and returns parsed signals', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: 'applied' } }],
    });
    const parser = new FakeSignalParserPort({
      results: [[note('did the thing')]],
    });
    const uc = new ApplyFeedbackUseCase(ai, parser, new FakeLoggerPort());

    const result = await uc.execute({
      sprint: aSprint(),
      promptFilePath: PROMPT_FILE,
      cwd: path('/repos/demo'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.signals).toHaveLength(1);
    expect(result.value.signals[0]?.type).toBe('note');
    expect(result.value.rawAiOutput).toBe('applied');
    // The wrapper handed to spawn references the prompt file path so
    // Claude reads the rendered file as its first action.
    expect(ai.captured).toHaveLength(1);
    expect(ai.captured[0]?.prompt).toContain(PROMPT_FILE);
  });

  it('propagates spawn failure', async () => {
    const failure = new StorageError({ subCode: 'io', message: 'spawn died' });
    const ai = new FakeAiSessionPort({ outcomes: [{ kind: 'error', error: failure }] });
    const uc = new ApplyFeedbackUseCase(ai, new FakeSignalParserPort(), new FakeLoggerPort());

    const result = await uc.execute({
      sprint: aSprint(),
      promptFilePath: PROMPT_FILE,
      cwd: path('/repos/demo'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('storage-error');
    }
  });

  it('forwards the abort signal to the AI session', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: '' } }],
    });
    const uc = new ApplyFeedbackUseCase(ai, new FakeSignalParserPort({ results: [[]] }), new FakeLoggerPort());
    const ac = new AbortController();

    await uc.execute({
      sprint: aSprint(),
      promptFilePath: PROMPT_FILE,
      cwd: path('/repos/demo'),
      abortSignal: ac.signal,
    });

    expect(ai.captured[0]?.options.abortSignal).toBe(ac.signal);
  });

  it('logs a warn for each parser diagnostic so silently-dropped output is observable', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: 'streamed' } }],
    });
    const parser = new FakeSignalParserPort({
      results: [[note('one')]],
      diagnostics: [
        [
          { kind: 'unclosed-tag', tag: 'progress', sample: '<progress>foo', index: 0 },
          { kind: 'malformed-dimension', sample: '**Correctness**: PASS', index: 14 },
        ],
      ],
    });
    const logger = new FakeLoggerPort();
    const uc = new ApplyFeedbackUseCase(ai, parser, logger);

    await uc.execute({
      sprint: aSprint(),
      promptFilePath: PROMPT_FILE,
      cwd: path('/repos/demo'),
    });

    const warns = logger.entries.filter((e) => e.level === 'warn' && e.message === 'signal parse diagnostic');
    expect(warns).toHaveLength(2);
    expect(warns[0]?.context).toMatchObject({ kind: 'unclosed-tag', sample: '<progress>foo' });
    expect(warns[1]?.context).toMatchObject({
      kind: 'malformed-dimension',
      sample: '**Correctness**: PASS',
    });
  });

  it('emits every parsed signal on the signal bus, tagged with sprintId', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: 'streamed' } }],
    });
    const parser = new FakeSignalParserPort({ results: [[note('one'), note('two')]] });
    const bus = new FakeSignalBusPort();
    const uc = new ApplyFeedbackUseCase(ai, parser, new FakeLoggerPort(), bus);

    const sprint = aSprint();
    await uc.execute({
      sprint,
      promptFilePath: PROMPT_FILE,
      cwd: path('/repos/demo'),
    });

    const signalEvents = bus.events.flatMap((e) =>
      e.type === 'signal' ? [{ sprintId: e.sprintId, signalType: e.signal.type }] : []
    );
    expect(signalEvents).toHaveLength(2);
    for (const e of signalEvents) {
      expect(e.sprintId).toBe(sprint.id);
      expect(e.signalType).toBe('note');
    }
  });
});
