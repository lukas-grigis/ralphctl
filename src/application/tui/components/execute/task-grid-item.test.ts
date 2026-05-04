import { describe, expect, it } from 'vitest';

import type {
  AgentsMdProposalSignal,
  CheckScriptDiscoverySignal,
  EvaluationSignal,
  NoteSignal,
  ProgressSignal,
  SetupScriptSignal,
  SkillSuggestionsSignal,
  TaskBlockedSignal,
  TaskCompleteSignal,
  TaskVerifiedSignal,
  VerifyScriptSignal,
} from '@src/domain/signals/harness-signal.ts';
import type { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { activityFromSignal } from './task-grid-item.ts';

/** Stable fake timestamp for all signal fixtures. */
const TS = '2026-04-29T12:00:00Z' as IsoTimestamp;

describe('activityFromSignal', () => {
  describe('progress', () => {
    it('returns the first 100 chars of summary for a summary shorter than 100 chars', () => {
      const signal: ProgressSignal = { type: 'progress', summary: 'short summary', timestamp: TS };
      expect(activityFromSignal(signal)).toBe('short summary');
    });

    it('slices summary to 100 chars when summary is longer than 100 chars', () => {
      const longSummary = 'a'.repeat(150);
      const signal: ProgressSignal = { type: 'progress', summary: longSummary, timestamp: TS };
      const result = activityFromSignal(signal);
      expect(result).toHaveLength(100);
      expect(result).toBe('a'.repeat(100));
    });
  });

  describe('note', () => {
    it('returns "note: <first 90 chars of text>" for short text', () => {
      const signal: NoteSignal = { type: 'note', text: 'all done', timestamp: TS };
      expect(activityFromSignal(signal)).toBe('note: all done');
    });

    it('slices note text to 90 chars', () => {
      const longText = 'b'.repeat(120);
      const signal: NoteSignal = { type: 'note', text: longText, timestamp: TS };
      expect(activityFromSignal(signal)).toBe(`note: ${'b'.repeat(90)}`);
    });
  });

  describe('task-verified', () => {
    it('returns "verified: <first 80 chars of output>"', () => {
      const signal: TaskVerifiedSignal = { type: 'task-verified', output: 'tests pass', timestamp: TS };
      expect(activityFromSignal(signal)).toBe('verified: tests pass');
    });

    it('slices output to 80 chars', () => {
      const longOutput = 'c'.repeat(100);
      const signal: TaskVerifiedSignal = { type: 'task-verified', output: longOutput, timestamp: TS };
      expect(activityFromSignal(signal)).toBe(`verified: ${'c'.repeat(80)}`);
    });
  });

  describe('task-complete', () => {
    it('returns "task complete"', () => {
      const signal: TaskCompleteSignal = { type: 'task-complete', timestamp: TS };
      expect(activityFromSignal(signal)).toBe('task complete');
    });
  });

  describe('task-blocked', () => {
    it('returns "blocked: <first 90 chars of reason>"', () => {
      const signal: TaskBlockedSignal = { type: 'task-blocked', reason: 'missing dep', timestamp: TS };
      expect(activityFromSignal(signal)).toBe('blocked: missing dep');
    });

    it('slices reason to 90 chars', () => {
      const longReason = 'd'.repeat(120);
      const signal: TaskBlockedSignal = { type: 'task-blocked', reason: longReason, timestamp: TS };
      expect(activityFromSignal(signal)).toBe(`blocked: ${'d'.repeat(90)}`);
    });
  });

  describe('evaluation', () => {
    it('returns "evaluation: passed" for a passed evaluation', () => {
      const signal: EvaluationSignal = {
        type: 'evaluation',
        status: 'passed',
        dimensions: [],
        timestamp: TS,
      };
      expect(activityFromSignal(signal)).toBe('evaluation: passed');
    });

    it('returns "evaluation: failed" for a failed evaluation', () => {
      const signal: EvaluationSignal = {
        type: 'evaluation',
        status: 'failed',
        dimensions: [],
        timestamp: TS,
      };
      expect(activityFromSignal(signal)).toBe('evaluation: failed');
    });
  });

  describe('non-display signal types return empty string', () => {
    it('check-script-discovery returns ""', () => {
      const signal: CheckScriptDiscoverySignal = {
        type: 'check-script-discovery',
        command: 'pnpm test',
        timestamp: TS,
      };
      expect(activityFromSignal(signal)).toBe('');
    });

    it('agents-md-proposal returns ""', () => {
      const signal: AgentsMdProposalSignal = {
        type: 'agents-md-proposal',
        content: '# Instructions',
        timestamp: TS,
      };
      expect(activityFromSignal(signal)).toBe('');
    });

    it('setup-script returns ""', () => {
      const signal: SetupScriptSignal = {
        type: 'setup-script',
        command: 'pnpm install',
        timestamp: TS,
      };
      expect(activityFromSignal(signal)).toBe('');
    });

    it('verify-script returns ""', () => {
      const signal: VerifyScriptSignal = {
        type: 'verify-script',
        command: 'pnpm test',
        timestamp: TS,
      };
      expect(activityFromSignal(signal)).toBe('');
    });

    it('skill-suggestions returns ""', () => {
      const signal: SkillSuggestionsSignal = {
        type: 'skill-suggestions',
        names: ['react-patterns'],
        timestamp: TS,
      };
      expect(activityFromSignal(signal)).toBe('');
    });
  });
});
