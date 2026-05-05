import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { evaluatorRoundDir, generatorRoundDir, roundDir, standaloneRoundDir } from './execution-round-paths.ts';

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
});
