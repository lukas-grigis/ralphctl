import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EvaluationSignal } from '@src/domain/signal.ts';
import { FIXED_NOW } from '@tests/fixtures/domain.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import {
  nextRoundNum,
  roundSignalsPath,
  writeEvaluatorRoundArtifacts,
} from '@src/application/flows/implement/leaves/round-artifacts.ts';

describe('round-artifacts', () => {
  let root: Awaited<ReturnType<typeof makeTmpRoot>>;

  beforeEach(async () => {
    root = await makeTmpRoot();
  });

  afterEach(async () => {
    await root.cleanup();
  });

  describe('nextRoundNum', () => {
    it('returns 1 when rounds/ does not exist yet', async () => {
      expect(await nextRoundNum(root.root)).toBe(1);
    });

    it('returns max(numeric children of rounds/) + 1', async () => {
      const rounds = join(String(root.root), 'rounds');
      await fs.mkdir(join(rounds, '1'), { recursive: true });
      await fs.mkdir(join(rounds, '2'), { recursive: true });
      await fs.mkdir(join(rounds, '7'), { recursive: true });
      expect(await nextRoundNum(root.root)).toBe(8);
    });

    it('ignores non-numeric entries when computing the max', async () => {
      const rounds = join(String(root.root), 'rounds');
      await fs.mkdir(join(rounds, '3'), { recursive: true });
      await fs.mkdir(join(rounds, 'scratch'), { recursive: true });
      await fs.mkdir(join(rounds, '5x'), { recursive: true });
      expect(await nextRoundNum(root.root)).toBe(4);
    });
  });

  describe('roundSignalsPath', () => {
    it('returns <workspaceRoot>/rounds/<N>/<role>/signals.json', () => {
      expect(roundSignalsPath(root.root, 3, 'generator')).toBe(
        join(String(root.root), 'rounds', '3', 'generator', 'signals.json')
      );
      expect(roundSignalsPath(root.root, 5, 'evaluator')).toBe(
        join(String(root.root), 'rounds', '5', 'evaluator', 'signals.json')
      );
    });
  });

  describe('writeEvaluatorRoundArtifacts', () => {
    it('renders evaluation.md from the evaluation signal', async () => {
      const evaluation: EvaluationSignal = {
        type: 'evaluation',
        status: 'failed',
        dimensions: [
          { dimension: 'correctness', score: 2, passed: false, finding: 'wrong return type' },
          { dimension: 'tests', score: 4, passed: true, finding: 'covers the happy path' },
        ],
        overallScore: 3,
        critique: 'Fix the return type before merging.',
        timestamp: FIXED_NOW,
      };
      await writeEvaluatorRoundArtifacts(root.root, 2, [evaluation]);

      const md = await fs.readFile(join(String(root.root), 'rounds', '2', 'evaluator', 'evaluation.md'), 'utf8');
      expect(md).toContain('**Status:** failed');
      expect(md).toContain('**Overall score:** 3.0');
      expect(md).toContain('**correctness** (2/5, failed): wrong return type');
      expect(md).toContain('**tests** (4/5, passed): covers the happy path');
      expect(md).toContain('Fix the return type before merging.');
    });

    it('renders a placeholder evaluation.md when no evaluation signal is present', async () => {
      await writeEvaluatorRoundArtifacts(root.root, 1, [{ type: 'note', text: 'observation', timestamp: FIXED_NOW }]);
      const md = await fs.readFile(join(String(root.root), 'rounds', '1', 'evaluator', 'evaluation.md'), 'utf8');
      expect(md).toMatch(/No.*verdict emitted/i);
    });

    it('does NOT write session.md — the body is no longer a first-class artifact', async () => {
      await writeEvaluatorRoundArtifacts(root.root, 1, []);
      const base = join(String(root.root), 'rounds', '1', 'evaluator');
      await expect(fs.readFile(join(base, 'session.md'), 'utf8')).rejects.toThrow();
    });
  });

  describe('resume semantics', () => {
    it('nextRoundNum skips past existing rounds so resume never overwrites', async () => {
      // Simulate a prior run: rounds/1/generator/ already exists with content.
      const round1Gen = join(String(root.root), 'rounds', '1', 'generator');
      await fs.mkdir(round1Gen, { recursive: true });
      await fs.writeFile(join(round1Gen, 'signals.json'), '["prior"]', 'utf8');

      // The resumed run computes N = 2 — the next round folder is untouched.
      expect(await nextRoundNum(root.root)).toBe(2);
      // Prior content is untouched.
      expect(await fs.readFile(join(round1Gen, 'signals.json'), 'utf8')).toBe('["prior"]');
    });
  });
});
