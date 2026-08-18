/**
 * `AiSession.chainSessionId` is the key the Execute view's token-usage map is read by
 * (`useTokenUsage(bus).get(sessionId)` with the OUTER runner id). On the parallel implement path
 * each task's subchain runs inside its own branch runner (`createRunner({ id: 'task-<taskId>' })`),
 * which re-scopes the ambient session — so a session stamped from the innermost id filed every
 * `token-usage` event under `task-<uuid>` and the header's token / context readout stayed blank
 * for the entire run while the serial path (one runner) showed it.
 */

import { describe, expect, it } from 'vitest';
import { runWithSession } from '@src/application/session/session.ts';
import { implementSession } from '@src/application/flows/implement/leaves/implement-session.ts';
import { absolutePath } from '@tests/fixtures/domain.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';

const PROMPT = 'unit-test prompt body' as unknown as Prompt;
const SANDBOX = absolutePath('/tmp/sandbox');
const REPO = absolutePath('/tmp/repo');
const SPRINT_DIR = absolutePath('/tmp/sprint');
const SIGNALS = absolutePath('/tmp/sandbox/rounds/1/generator/signals.json');

const build = (): ReturnType<typeof implementSession> =>
  implementSession(SANDBOX, REPO, SPRINT_DIR, PROMPT, 'claude-opus-4-8', SIGNALS, 'generator');

describe('implementSession — chainSessionId keying', () => {
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
