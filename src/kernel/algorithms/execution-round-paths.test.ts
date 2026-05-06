import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  evaluatorRoundDir,
  evaluatorVerdictSprintRelative,
  generatorRoundDir,
  roundDir,
  standaloneEvaluatorVerdictSprintRelative,
  standaloneRoundDir,
} from './execution-round-paths.ts';

const UNIT_ROOT = '/tmp/sprint/execution/task-001-do-the-thing';

describe('execution-round-paths', () => {
  describe('roundDir', () => {
    it('joins unitRoot with rounds/<round>', () => {
      expect(roundDir(UNIT_ROOT, 1)).toBe(join(UNIT_ROOT, 'rounds', '1'));
    });
  });

  describe('generatorRoundDir', () => {
    it('joins unitRoot with rounds/<round>/generator', () => {
      expect(generatorRoundDir(UNIT_ROOT, 2)).toBe(join(UNIT_ROOT, 'rounds', '2', 'generator'));
    });
  });

  describe('evaluatorRoundDir', () => {
    it('joins unitRoot with rounds/<round>/evaluator', () => {
      expect(evaluatorRoundDir(UNIT_ROOT, 3)).toBe(join(UNIT_ROOT, 'rounds', '3', 'evaluator'));
    });
  });

  describe('standaloneRoundDir', () => {
    it('joins unitRoot with rounds/standalone-<iso>', () => {
      const iso = '2026-05-05T12-34-56-789Z';
      expect(standaloneRoundDir(UNIT_ROOT, iso)).toBe(join(UNIT_ROOT, 'rounds', `standalone-${iso}`));
    });
  });

  describe('evaluatorVerdictSprintRelative', () => {
    it('builds execution/<slug>/rounds/<round>/evaluator/evaluation.md', () => {
      expect(evaluatorVerdictSprintRelative('abc123-do-thing', 2)).toBe(
        join('execution', 'abc123-do-thing', 'rounds', '2', 'evaluator', 'evaluation.md')
      );
    });
  });

  describe('standaloneEvaluatorVerdictSprintRelative', () => {
    it('builds execution/<slug>/rounds/standalone-<iso>/evaluator/evaluation.md', () => {
      const iso = '2026-05-05T12-34-56-789Z-abcd';
      expect(standaloneEvaluatorVerdictSprintRelative('abc123-do-thing', iso)).toBe(
        join('execution', 'abc123-do-thing', 'rounds', `standalone-${iso}`, 'evaluator', 'evaluation.md')
      );
    });
  });
});
