import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { HeadlessAiProvider, ProviderOutput } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { READ_ONLY } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { createInMemorySink } from '@tests/fixtures/in-memory-sink.ts';
import { createFakeAiProvider, MARKERS } from '@tests/fixtures/fake-ai-provider.ts';
import { consumeSignals } from '@src/integration/ai/signals/_engine/consume-signals.ts';
import { withSignalsTempPath } from '@src/integration/ai/signals/_engine/temp-signals-file.ts';

const PROMPT = (s: string): Prompt => s as Prompt;

const baseSession = (signalsFile: AiSession['signalsFile'], promptBody: string): AiSession => ({
  prompt: PROMPT(promptBody),
  cwd: absolutePath('/tmp/consume-signals-test'),
  model: 'claude-sonnet-4-6',
  permissions: READ_ONLY,
  signalsFile,
});

describe('consumeSignals', () => {
  it('returns the parsed signal array on success', async () => {
    const provider = createFakeAiProvider({
      responses: { implement: '<task-verified>tests pass</task-verified>' },
    });
    const sink = createInMemorySink<HarnessSignal>();

    const result = await withSignalsTempPath('consume-happy', async (signalsFile) =>
      consumeSignals(provider, baseSession(signalsFile, `${MARKERS.implement}\nbody`), sink)
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.map((s) => s.type)).toEqual(['task-verified']);
  });

  it('fans out every signal to the sink in document order', async () => {
    const provider = createFakeAiProvider({
      responses: {
        implement: '<progress>working</progress>\n<task-verified>ok</task-verified>\n<task-complete/>',
      },
    });
    const sink = createInMemorySink<HarnessSignal>();

    await withSignalsTempPath('consume-fan', async (signalsFile) =>
      consumeSignals(provider, baseSession(signalsFile, `${MARKERS.implement}\nbody`), sink)
    );

    expect(sink.entries.map((s) => s.type)).toEqual(['progress', 'task-verified', 'task-complete']);
  });

  it('propagates the provider error without writing to the sink', async () => {
    // Bare provider that fails immediately.
    const failingProvider: HeadlessAiProvider = {
      async generate() {
        return Result.error(
          new InvalidStateError({
            entity: 'fake-provider',
            currentState: 'down',
            attemptedAction: 'generate',
            message: 'provider unavailable',
          })
        ) as Result<ProviderOutput, DomainError>;
      },
    };
    const sink = createInMemorySink<HarnessSignal>();

    const result = await withSignalsTempPath('consume-fail', async (signalsFile) =>
      consumeSignals(failingProvider, baseSession(signalsFile, `${MARKERS.implement}\n`), sink)
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('provider unavailable');
    expect(sink.entries).toEqual([]);
  });

  it('surfaces a NotFoundError when the provider returned ok but the file is missing (defensive)', async () => {
    // A provider that "succeeds" but writes nothing — this can happen with a broken test seam,
    // or in production if a disk-full hit between the success path and writeJsonAtomic somehow
    // got masked. The helper must still surface it cleanly rather than silently emitting [].
    const lyingProvider: HeadlessAiProvider = {
      async generate(session) {
        return Result.ok({ signalsFile: session.signalsFile, exitCode: 0 }) as Result<ProviderOutput, DomainError>;
      },
    };
    const sink = createInMemorySink<HarnessSignal>();

    const result = await withSignalsTempPath('consume-lying', async (signalsFile) =>
      consumeSignals(lyingProvider, baseSession(signalsFile, `${MARKERS.implement}\n`), sink)
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/file not found/i);
    expect(sink.entries).toEqual([]);
  });

  it('handles an empty signals file as an empty array (no sink emissions)', async () => {
    // Provider runs successfully, AI emitted no recognised tags.
    const provider = createFakeAiProvider({
      responses: { implement: 'plain prose, no tags here' },
    });
    const sink = createInMemorySink<HarnessSignal>();

    const result = await withSignalsTempPath('consume-empty', async (signalsFile) =>
      consumeSignals(provider, baseSession(signalsFile, `${MARKERS.implement}\nbody`), sink)
    );

    expect(result.ok && result.value).toEqual([]);
    expect(sink.entries).toEqual([]);
  });
});
