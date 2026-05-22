import { describe, expect, it } from 'vitest';
import { implementSession } from '@src/application/flows/implement/leaves/implement-session.ts';
import { absolutePath } from '@tests/fixtures/domain.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { SessionId } from '@src/integration/ai/providers/_engine/session-id.ts';

const PROMPT = 'unit-test prompt body' as unknown as Prompt;
const SANDBOX = absolutePath('/tmp/sandbox');
const REPO = absolutePath('/tmp/repo');
const SIGNALS = absolutePath('/tmp/signals.json');

describe('implementSession', () => {
  it('omits `resume` when no prior session id is supplied (round 1 / fresh task path)', () => {
    const session = implementSession(SANDBOX, REPO, PROMPT, 'claude-opus-4-7', SIGNALS);
    expect(session).not.toHaveProperty('resume');
  });

  it('forwards `resume` onto the session descriptor when a prior session id is supplied', () => {
    const prior = 'gen-session-abc-123' as SessionId;
    const session = implementSession(SANDBOX, REPO, PROMPT, 'claude-opus-4-7', SIGNALS, prior);
    expect(session.resume).toBe(prior);
  });

  it('keeps cwd at the repo and mounts the sandbox via additionalRoots — resume must not change session topology', () => {
    const prior = 'gen-session-abc-123' as SessionId;
    const session = implementSession(SANDBOX, REPO, PROMPT, 'claude-opus-4-7', SIGNALS, prior);
    expect(session.cwd).toBe(REPO);
    expect(session.additionalRoots).toEqual([SANDBOX]);
    expect(session.signalsFile).toBe(SIGNALS);
  });
});
