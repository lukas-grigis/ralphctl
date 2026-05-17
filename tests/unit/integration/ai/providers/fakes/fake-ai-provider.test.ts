import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import { READ_ONLY } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { createFakeAiProvider, MARKERS } from '@tests/fixtures/fake-ai-provider.ts';

const asPrompt = (s: string): Prompt => s as Prompt;

let signalsCounter = 0;
const tempSignalsFile = () => {
  signalsCounter += 1;
  return absolutePath(
    join(tmpdir(), `ralphctl-fake-ai-${String(process.pid)}-${String(Date.now())}-${String(signalsCounter)}.json`)
  );
};

const session = (prompt: string, overrides: Partial<AiSession> = {}): AiSession => ({
  prompt: asPrompt(prompt),
  cwd: absolutePath('/tmp'),
  model: 'claude-sonnet-4-6',
  permissions: READ_ONLY,
  signalsFile: tempSignalsFile(),
  ...overrides,
});

const readSignals = async (path: string): Promise<readonly HarnessSignal[]> => {
  const raw = await fs.readFile(path, 'utf8');
  return JSON.parse(raw) as readonly HarnessSignal[];
};

describe('createFakeAiProvider', () => {
  it('dispatches by template marker and writes empty signals when none scripted', async () => {
    const provider = createFakeAiProvider({
      responses: { refine: '# refined-body' },
    });

    const result = await provider.generate(session(`${MARKERS.refine}\n\nbody…`));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.exitCode).toBe(0);
      const signals = await readSignals(String(result.value.signalsFile));
      expect(signals).toEqual([]);
    }
  });

  it('writes scripted signals to signalsFile', async () => {
    const ts = IsoTimestamp.now();
    const provider = createFakeAiProvider({
      signals: {
        refine: [
          { type: 'progress', summary: 'thinking', timestamp: ts },
          { type: 'note', text: 'almost', timestamp: ts },
        ],
      },
    });

    const result = await provider.generate(session(`${MARKERS.refine}\n`));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const signals = await readSignals(String(result.value.signalsFile));
      expect(signals.map((s) => s.type)).toEqual(['progress', 'note']);
    }
  });

  it('threads scripted sessionId onto the result', async () => {
    const provider = createFakeAiProvider({
      sessionIds: { refine: 'sess-xyz' },
    });

    const result = await provider.generate(session(`${MARKERS.refine}\n`));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.sessionId).toBe('sess-xyz');
  });

  it('returns InvalidStateError when no marker matches the prompt body', async () => {
    const provider = createFakeAiProvider({});
    const result = await provider.generate(session('no marker in here'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(InvalidStateError);
  });

  it('honours markerOverrides for templates not in the default map', async () => {
    const provider = createFakeAiProvider({
      signals: { 'custom-template': [{ type: 'note', text: 'custom', timestamp: IsoTimestamp.now() }] },
      markerOverrides: { 'custom-template': '# Custom Marker Line' },
    });

    const result = await provider.generate(session('# Custom Marker Line\nbody'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const signals = await readSignals(String(result.value.signalsFile));
      expect(signals).toHaveLength(1);
    }
  });
});
