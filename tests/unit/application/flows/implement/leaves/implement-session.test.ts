import { describe, expect, it } from 'vitest';
import { implementSession } from '@src/application/flows/implement/leaves/implement-session.ts';
import { absolutePath } from '@tests/fixtures/domain.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { SessionId } from '@src/integration/ai/providers/_engine/session-id.ts';

const PROMPT = 'unit-test prompt body' as unknown as Prompt;
const SANDBOX = absolutePath('/tmp/sandbox');
const REPO = absolutePath('/tmp/repo');
const SPRINT_DIR = absolutePath('/tmp/sprint');
const SIGNALS = absolutePath('/tmp/signals.json');

describe('implementSession', () => {
  it('omits `resume` when no prior session id is supplied (round 1 / fresh task path)', () => {
    const session = implementSession(SANDBOX, REPO, SPRINT_DIR, PROMPT, 'claude-opus-4-7', SIGNALS);
    expect(session).not.toHaveProperty('resume');
  });

  it('forwards `resume` onto the session descriptor when a prior session id is supplied', () => {
    const prior = 'gen-session-abc-123' as SessionId;
    const session = implementSession(SANDBOX, REPO, SPRINT_DIR, PROMPT, 'claude-opus-4-7', SIGNALS, prior);
    expect(session.resume).toBe(prior);
  });

  it('keeps cwd at the repo and mounts BOTH the sandbox and the sprint dir via additionalRoots', () => {
    const prior = 'gen-session-abc-123' as SessionId;
    const session = implementSession(SANDBOX, REPO, SPRINT_DIR, PROMPT, 'claude-opus-4-7', SIGNALS, prior);
    expect(session.cwd).toBe(REPO);
    // Order matters: the sandbox comes first (per-task workspace the AI uses every spawn),
    // sprintDir second (sibling artifacts like progress.md).
    expect(session.additionalRoots).toEqual([SANDBOX, SPRINT_DIR]);
    expect(session.signalsFile).toBe(SIGNALS);
  });
});
