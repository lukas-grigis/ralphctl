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
  writeRoundPrompt,
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
    it('renders evaluation.md as H1 + per-dimension H2 sections + critique bullets', async () => {
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
      // H1 + status headline.
      expect(md).toMatch(/^# Evaluation\b/);
      expect(md).toContain('**Status:** failed · **Overall:** 3.0 / 5 · **Verdict signal:** `<evaluation-failed>`');
      // Per-dimension H2 sections.
      expect(md).toContain('## Correctness — failed (2/5)');
      expect(md).toContain('## Tests — passed (4/5)');
      // Each finding becomes its own bullet under its dimension's H2.
      expect(md).toContain('- wrong return type');
      expect(md).toContain('- covers the happy path');
      // Critique becomes a bullet list under ## Critique.
      expect(md).toContain('## Critique');
      expect(md).toContain('- Fix the return type before merging.');
    });

    it('interpolates the task name into the H1 when supplied', async () => {
      const evaluation: EvaluationSignal = {
        type: 'evaluation',
        status: 'passed',
        dimensions: [{ dimension: 'correctness', score: 5, passed: true, finding: 'all good' }],
        overallScore: 5,
        timestamp: FIXED_NOW,
      };
      await writeEvaluatorRoundArtifacts(root.root, 3, [evaluation], undefined, 'Add gated dashboard demo banner');
      const md = await fs.readFile(join(String(root.root), 'rounds', '3', 'evaluator', 'evaluation.md'), 'utf8');
      expect(md).toContain('# Evaluation — Add gated dashboard demo banner');
      expect(md).toContain('**Verdict signal:** `<evaluation-passed>`');
    });

    it('splits multi-bullet findings (newline-separated AND inline " - " separated) into one bullet each', async () => {
      const evaluation: EvaluationSignal = {
        type: 'evaluation',
        status: 'failed',
        dimensions: [
          {
            dimension: 'completeness',
            score: 3,
            passed: false,
            finding: '- first observation\n- second observation\n- third observation',
          },
          {
            dimension: 'consistency',
            score: 3,
            passed: false,
            finding: 'inline one - inline two - inline three',
          },
        ],
        overallScore: 3,
        timestamp: FIXED_NOW,
      };
      await writeEvaluatorRoundArtifacts(root.root, 4, [evaluation]);
      const md = await fs.readFile(join(String(root.root), 'rounds', '4', 'evaluator', 'evaluation.md'), 'utf8');
      expect(md).toContain('- first observation');
      expect(md).toContain('- second observation');
      expect(md).toContain('- third observation');
      expect(md).toContain('- inline one');
      expect(md).toContain('- inline two');
      expect(md).toContain('- inline three');
    });

    it('splits a paragraph-separated critique into one bullet per paragraph', async () => {
      const evaluation: EvaluationSignal = {
        type: 'evaluation',
        status: 'failed',
        dimensions: [{ dimension: 'correctness', score: 3, passed: false, finding: 'fail' }],
        overallScore: 3,
        critique: '[Correctness] First point about the failure.\n\n[Consistency] Second point about drift.',
        timestamp: FIXED_NOW,
      };
      await writeEvaluatorRoundArtifacts(root.root, 5, [evaluation]);
      const md = await fs.readFile(join(String(root.root), 'rounds', '5', 'evaluator', 'evaluation.md'), 'utf8');
      expect(md).toContain('- [Correctness] First point about the failure.');
      expect(md).toContain('- [Consistency] Second point about drift.');
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

  describe('writeRoundPrompt', () => {
    it('writes prompt.md atomically into rounds/<N>/<role>/', async () => {
      await writeRoundPrompt(root.root, 4, 'generator', 'hello prompt body');
      const path = join(String(root.root), 'rounds', '4', 'generator', 'prompt.md');
      expect(await fs.readFile(path, 'utf8')).toBe('hello prompt body');

      await writeRoundPrompt(root.root, 4, 'evaluator', 'evaluator brief');
      const evalPath = join(String(root.root), 'rounds', '4', 'evaluator', 'prompt.md');
      expect(await fs.readFile(evalPath, 'utf8')).toBe('evaluator brief');
    });

    it('leaves no .tmp leftover after a successful write (rename-based atomicity)', async () => {
      await writeRoundPrompt(root.root, 2, 'generator', 'body');
      const dir = join(String(root.root), 'rounds', '2', 'generator');
      const entries = await fs.readdir(dir);
      expect(entries).toContain('prompt.md');
      expect(entries.filter((e) => e.includes('.tmp.'))).toEqual([]);
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
