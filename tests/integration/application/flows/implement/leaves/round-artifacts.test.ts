import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import {
  nextRoundNum,
  readLastGeneratorRound,
  readRoundSessionId,
  roundSignalsPath,
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

  describe('readRoundSessionId', () => {
    it('reads the captured session id when the sibling file exists', async () => {
      const dir = join(String(root.root), 'rounds', '3', 'generator');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(join(dir, 'session-id.txt'), 'gen-session-xyz\n', 'utf8');
      expect(await readRoundSessionId(root.root, 3, 'generator')).toBe('gen-session-xyz');
    });

    it('returns undefined when the session-id.txt file is absent (provider never reported one)', async () => {
      expect(await readRoundSessionId(root.root, 99, 'generator')).toBeUndefined();
      expect(await readRoundSessionId(root.root, 99, 'evaluator')).toBeUndefined();
    });

    it('returns undefined for an empty session-id.txt file rather than a zero-length id', async () => {
      const dir = join(String(root.root), 'rounds', '7', 'evaluator');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(join(dir, 'session-id.txt'), '\n', 'utf8');
      expect(await readRoundSessionId(root.root, 7, 'evaluator')).toBeUndefined();
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

  describe('readLastGeneratorRound', () => {
    const seed = async (round: number, files: { readonly sid?: string; readonly meta?: object | string }) => {
      const dir = join(String(root.root), 'rounds', String(round), 'generator');
      await fs.mkdir(dir, { recursive: true });
      if (files.sid !== undefined) await fs.writeFile(join(dir, 'session-id.txt'), `${files.sid}\n`);
      if (files.meta !== undefined) {
        const body = typeof files.meta === 'string' ? files.meta : JSON.stringify(files.meta);
        await fs.writeFile(join(dir, 'role-meta.json'), body);
      }
    };
    const META = { role: 'generator', provider: 'claude-code', model: 'm', attemptN: 2, roundN: 0, cwd: '/repo' };

    it('returns the newest round that captured a session id, with its role-meta attribution', async () => {
      await seed(2, { sid: 'older', meta: META });
      await seed(10, { sid: 'newest', meta: META });
      // A round whose spawn died before reporting an id is skipped.
      await seed(11, { meta: META });
      expect(await readLastGeneratorRound(root.root)).toEqual({
        roundN: 10,
        attemptN: 2,
        sessionId: 'newest',
        provider: 'claude-code',
        model: 'm',
        cwd: '/repo',
      });
    });

    it('returns undefined when the newest id has no readable attribution — an unattributed session is never resumed', async () => {
      await seed(1, { sid: 'attributed', meta: META });
      await seed(2, { sid: 'orphan', meta: '{ not json' });
      expect(await readLastGeneratorRound(root.root)).toBeUndefined();
    });

    it('omits cwd for a round stamped before cwd was recorded', async () => {
      const legacy: Record<string, unknown> = { ...META };
      delete legacy['cwd'];
      await seed(1, { sid: 'legacy', meta: legacy });
      expect((await readLastGeneratorRound(root.root))?.cwd).toBeUndefined();
    });

    it('returns undefined when there are no rounds at all', async () => {
      expect(await readLastGeneratorRound(root.root)).toBeUndefined();
    });
  });
});
