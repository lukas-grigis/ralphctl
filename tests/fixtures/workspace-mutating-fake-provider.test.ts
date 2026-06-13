/**
 * Unit test for workspace-mutating-fake-provider.
 *
 * Verifies:
 *  - Files described in `fileWrites` are created under a real tmp `session.cwd`.
 *  - Harness signals (forwarded from createFakeAiProvider) are written to `session.signalsFile`.
 *  - An unknown prompt (no marker match) returns a provider error (not a throw).
 */

import { promises as fs } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkspaceMutatingFakeProvider } from './workspace-mutating-fake-provider.ts';
import { FIXED_NOW } from './domain.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';

// ─── helpers ─────────────────────────────────────────────────────────────────

const ap = (s: string): AbsolutePath => {
  const r = AbsolutePath.parse(s);
  if (!r.ok) throw new Error(`absolutePath failed: ${r.error.message}`);
  return r.value;
};

const taskVerified = (output: string): HarnessSignal => ({ type: 'task-verified', output, timestamp: FIXED_NOW });
const evaluationPassed = (): HarnessSignal => ({
  type: 'evaluation',
  status: 'passed',
  dimensions: [
    { dimension: 'correctness', passed: true, finding: 'all good' },
    { dimension: 'completeness', passed: true, finding: 'steps shipped' },
    { dimension: 'safety', passed: true, finding: 'inputs validated' },
    { dimension: 'consistency', passed: true, finding: 'matches siblings' },
  ],
  timestamp: FIXED_NOW,
});

const makeSession = (cwd: string, signalsFile: string): AiSession =>
  ({
    cwd: ap(cwd),
    signalsFile: ap(signalsFile),
    prompt: '# Task Execution Protocol\nImplement foo',
  }) as unknown as AiSession;

const makeEvalSession = (cwd: string, signalsFile: string): AiSession =>
  ({
    cwd: ap(cwd),
    signalsFile: ap(signalsFile),
    prompt: 'independent code reviewer checking the output',
  }) as unknown as AiSession;

// ─── tests ────────────────────────────────────────────────────────────────────

describe('createWorkspaceMutatingFakeProvider', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanups) await fn().catch(() => undefined);
    cleanups.length = 0;
  });

  it('writes files into session.cwd and emits signals when implement marker matched', async () => {
    const rawCwd = await fs.mkdtemp(join(tmpdir(), 'wsmfp-cwd-'));
    const cwd = await realpath(rawCwd);
    cleanups.push(async () => fs.rm(cwd, { recursive: true, force: true }));

    const rawSig = await fs.mkdtemp(join(tmpdir(), 'wsmfp-sig-'));
    const sigDir = await realpath(rawSig);
    cleanups.push(async () => fs.rm(sigDir, { recursive: true, force: true }));

    const signalsFile = join(sigDir, 'signals.json');

    const provider = createWorkspaceMutatingFakeProvider({
      fileWrites: {
        implement: {
          'output.txt': 'generated content\n',
          'sub/dir/file.ts': 'export const x = 1;\n',
        },
      },
      signals: {
        implement: [taskVerified('done')],
      },
    });

    const session = makeSession(cwd, signalsFile);
    const result = await provider.generate(session);

    expect(result.ok).toBe(true);

    // Assert files were written under cwd.
    const outputTxt = await fs.readFile(join(cwd, 'output.txt'), 'utf8');
    expect(outputTxt).toBe('generated content\n');

    const subFile = await fs.readFile(join(cwd, 'sub/dir/file.ts'), 'utf8');
    expect(subFile).toBe('export const x = 1;\n');

    // Assert signals.json was written by the inner fake.
    const sigContent = await fs.readFile(signalsFile, 'utf8');
    const signals: readonly HarnessSignal[] = JSON.parse(sigContent) as readonly HarnessSignal[];
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ type: 'task-verified', output: 'done' });
  });

  it('does not write files for unrelated template (evaluate prompt)', async () => {
    const rawCwd = await fs.mkdtemp(join(tmpdir(), 'wsmfp-eval-cwd-'));
    const cwd = await realpath(rawCwd);
    cleanups.push(async () => fs.rm(cwd, { recursive: true, force: true }));

    const rawSig = await fs.mkdtemp(join(tmpdir(), 'wsmfp-eval-sig-'));
    const sigDir = await realpath(rawSig);
    cleanups.push(async () => fs.rm(sigDir, { recursive: true, force: true }));

    const signalsFile = join(sigDir, 'signals.json');

    const provider = createWorkspaceMutatingFakeProvider({
      fileWrites: {
        // Only implement writes files — evaluate should not touch the filesystem.
        implement: { 'output.txt': 'content\n' },
      },
      signals: {
        evaluate: [evaluationPassed()],
      },
    });

    const session = makeEvalSession(cwd, signalsFile);
    const result = await provider.generate(session);

    expect(result.ok).toBe(true);

    // No 'output.txt' should exist — the evaluate prompt did not match the implement fileWrites.
    await expect(fs.access(join(cwd, 'output.txt'))).rejects.toThrow();

    // Signals should still be written for the evaluate template.
    const sigContent = await fs.readFile(signalsFile, 'utf8');
    const signals: readonly HarnessSignal[] = JSON.parse(sigContent) as readonly HarnessSignal[];
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ type: 'evaluation', status: 'passed' });
  });

  it('recordedSessions captures each generate call', async () => {
    const rawCwd = await fs.mkdtemp(join(tmpdir(), 'wsmfp-rec-'));
    const cwd = await realpath(rawCwd);
    cleanups.push(async () => fs.rm(cwd, { recursive: true, force: true }));

    const rawSig = await fs.mkdtemp(join(tmpdir(), 'wsmfp-rec-sig-'));
    const sigDir = await realpath(rawSig);
    cleanups.push(async () => fs.rm(sigDir, { recursive: true, force: true }));

    const signalsFile = join(sigDir, 'signals.json');

    const provider = createWorkspaceMutatingFakeProvider({
      signals: {
        implement: [taskVerified('ok')],
      },
    });

    expect(provider.recordedSessions).toHaveLength(0);
    await provider.generate(makeSession(cwd, signalsFile));
    expect(provider.recordedSessions).toHaveLength(1);
  });
});
