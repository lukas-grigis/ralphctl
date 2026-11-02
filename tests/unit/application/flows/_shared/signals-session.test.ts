/**
 * `AiSession.chainSessionId` is the key the Execute view's token-usage map is read by (the OUTER
 * runner id). A parallel implement branch runner re-scopes the ambient session, so stamping the
 * innermost id filed every `token-usage` event under `task-<uuid>` and the readout stayed blank.
 */

import { describe, expect, it } from 'vitest';
import { runWithSession } from '@src/application/session/session.ts';
import { signalsSession, type SignalsSessionOpts } from '@src/application/flows/_shared/signals-session.ts';
import { FULL_AUTO } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import { absolutePath } from '@tests/fixtures/domain.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { SessionId } from '@src/integration/ai/providers/_engine/session-id.ts';

const PROMPT = 'unit-test prompt body' as unknown as Prompt;
const COLD = 'full prompt body' as unknown as Prompt;

const build = (overrides: Partial<SignalsSessionOpts> = {}): ReturnType<typeof signalsSession> =>
  signalsSession({
    prompt: PROMPT,
    cwd: absolutePath('/tmp/repo'),
    model: 'claude-opus-4-8',
    permissions: FULL_AUTO,
    signalsFile: absolutePath('/tmp/sandbox/rounds/1/generator/signals.json'),
    outputDir: absolutePath('/tmp/sandbox/rounds/1/generator'),
    ...overrides,
  });

describe('signalsSession', () => {
  it('omits every optional field that was not supplied (or supplied as undefined)', () => {
    const session = build({ resume: undefined, effort: undefined, abortSignal: undefined, bodyFile: undefined });
    for (const key of ['resume', 'coldPrompt', 'effort', 'abortSignal', 'bodyFile', 'role', 'additionalRoots']) {
      expect(session).not.toHaveProperty(key);
    }
  });

  it('forwards the optional fields when supplied', () => {
    const controller = new AbortController();
    const body = absolutePath('/tmp/sandbox/rounds/1/generator/body.txt');
    const roots = [absolutePath('/tmp/sandbox'), absolutePath('/tmp/sprint')];
    const session = build({
      effort: 'high',
      abortSignal: controller.signal,
      bodyFile: body,
      role: 'evaluator',
      additionalRoots: roots,
    });
    expect(session.effort).toBe('high');
    expect(session.abortSignal).toBe(controller.signal);
    expect(session.bodyFile).toBe(body);
    expect(session.role).toBe('evaluator');
    expect(session.additionalRoots).toEqual(roots);
  });

  it('carries coldPrompt only alongside resume', () => {
    const prior = 'gen-session-abc-123' as SessionId;
    const resumed = build({ resume: prior, coldPrompt: COLD });
    expect(resumed.resume).toBe(prior);
    expect(resumed.coldPrompt).toBe(COLD);
    expect(build({ coldPrompt: COLD })).not.toHaveProperty('coldPrompt');
  });

  describe('chainSessionId keying', () => {
    it('omits chainSessionId outside any session scope', () => {
      expect(build()).not.toHaveProperty('chainSessionId');
    });

    it('stamps the runner id on the serial path (single scope)', async () => {
      await runWithSession('r-serial-1', () => {
        expect(build().chainSessionId).toBe('r-serial-1');
      });
    });

    it('stamps the HOST runner id from inside a parallel branch runner scope', async () => {
      await runWithSession('r-host-1', async () => {
        await runWithSession('task-01933fbb-1111-7000-8000-000000000001', () => {
          expect(build().chainSessionId).toBe('r-host-1');
        });
      });
    });
  });
});
