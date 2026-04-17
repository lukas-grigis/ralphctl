/**
 * Narrow tests on `buildResumeArgs` for both providers.
 *
 * Rationale: the executor's session-resume wiring threads a captured
 * session ID through `spawnHeadlessRaw`, which then calls
 * `provider.buildResumeArgs(sessionId)` and appends the result to the CLI
 * argv. These tests pin the CLI-flag shape so a provider change doesn't
 * silently break `--resume`.
 */

import { describe, it, expect } from 'vitest';
import { claudeAdapter } from './claude.ts';
import { copilotAdapter } from './copilot.ts';

describe('buildResumeArgs', () => {
  describe('claude', () => {
    it('emits `--resume <sessionId>` as two separate argv entries', () => {
      const args = claudeAdapter.buildResumeArgs('session-abc-123');
      expect(args).toEqual(['--resume', 'session-abc-123']);
    });

    it('rejects malformed session IDs', () => {
      expect(() => claudeAdapter.buildResumeArgs('-injected --flag')).toThrow(/Invalid session ID format/);
      expect(() => claudeAdapter.buildResumeArgs('')).toThrow(/Invalid session ID format/);
    });
  });

  describe('copilot', () => {
    it('emits `--resume=<sessionId>` as a single argv entry (optional-value syntax)', () => {
      const args = copilotAdapter.buildResumeArgs('session-abc-123');
      expect(args).toEqual(['--resume=session-abc-123']);
    });

    it('rejects malformed session IDs', () => {
      expect(() => copilotAdapter.buildResumeArgs('-injected --flag')).toThrow(/Invalid session ID format/);
      expect(() => copilotAdapter.buildResumeArgs('')).toThrow(/Invalid session ID format/);
    });
  });
});
