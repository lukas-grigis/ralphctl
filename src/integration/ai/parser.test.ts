import { describe, expect, it } from 'vitest';
import { parseExecutionResult } from '@src/integration/ai/parser.ts';

describe('parseExecutionResult', () => {
  describe('task-complete with task-verified', () => {
    it('returns success=true and verified=true when both signals present', () => {
      const output = '<task-verified>all checks passed</task-verified>\n<task-complete>';
      const result = parseExecutionResult(output);
      expect(result.success).toBe(true);
      expect(result.verified).toBe(true);
      expect(result.verificationOutput).toBe('all checks passed');
      expect(result.blockedReason).toBeUndefined();
    });

    it('captures multiline content inside task-verified', () => {
      const output = '<task-verified>line1\nline2\nline3</task-verified>\n<task-complete>';
      const result = parseExecutionResult(output);
      expect(result.success).toBe(true);
      expect(result.verified).toBe(true);
      expect(result.verificationOutput).toBe('line1\nline2\nline3');
    });
  });

  describe('task-complete without task-verified', () => {
    it('returns success=false with "without verification" in blockedReason', () => {
      const output = 'some work done\n<task-complete>';
      const result = parseExecutionResult(output);
      expect(result.success).toBe(false);
      expect(result.blockedReason).toMatch(/without verification/i);
      expect(result.verified).toBeFalsy();
    });
  });

  describe('task-blocked signal', () => {
    it('returns success=false with the blocked reason', () => {
      const output = '<task-blocked>missing dependency on external service</task-blocked>';
      const result = parseExecutionResult(output);
      expect(result.success).toBe(false);
      expect(result.blockedReason).toBe('missing dependency on external service');
    });

    it('treats empty task-blocked tag as no signal (malformed)', () => {
      const output = '<task-blocked></task-blocked>';
      const result = parseExecutionResult(output);
      expect(result.success).toBe(false);
      expect(result.blockedReason).toBe('No completion signal received');
    });

    it('trims whitespace from blocked reason', () => {
      const output = '<task-blocked>  needs more info  </task-blocked>';
      const result = parseExecutionResult(output);
      expect(result.blockedReason).toBe('needs more info');
    });
  });

  describe('no signals at all', () => {
    it('returns success=false with "No completion signal received"', () => {
      const output = 'I did some work but forgot to signal completion.';
      const result = parseExecutionResult(output);
      expect(result.success).toBe(false);
      expect(result.blockedReason).toBe('No completion signal received');
      expect(result.verified).toBe(false);
    });

    it('handles empty string input', () => {
      const result = parseExecutionResult('');
      expect(result.success).toBe(false);
      expect(result.blockedReason).toBe('No completion signal received');
      expect(result.verified).toBe(false);
    });
  });

  describe('task-verified alone (no complete or blocked)', () => {
    it('returns success=false but verified=true with verificationOutput set', () => {
      const output = '<task-verified>verification output here</task-verified>';
      const result = parseExecutionResult(output);
      expect(result.success).toBe(false);
      expect(result.verified).toBe(true);
      expect(result.verificationOutput).toBe('verification output here');
      expect(result.blockedReason).toBe('No completion signal received');
    });
  });

  describe('task-verified and task-blocked together', () => {
    it('returns success=false, blocked reason present, verified=true', () => {
      const output =
        '<task-verified>partial check passed</task-verified>\n<task-blocked>cannot finish due to missing file</task-blocked>';
      const result = parseExecutionResult(output);
      expect(result.success).toBe(false);
      expect(result.blockedReason).toBe('cannot finish due to missing file');
      expect(result.verified).toBe(true);
      expect(result.verificationOutput).toBe('partial check passed');
    });
  });

  describe('large output', () => {
    it('correctly parses signals at the end of ~10KB output', () => {
      const padding = 'x'.repeat(10_000);
      const output = `${padding}\n<task-verified>ok</task-verified>\n<task-complete>`;
      const result = parseExecutionResult(output);
      expect(result.success).toBe(true);
      expect(result.verified).toBe(true);
      expect(result.verificationOutput).toBe('ok');
    });
  });
});
