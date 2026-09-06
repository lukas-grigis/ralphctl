/**
 * The snapshot is written into the sprint data directory, so the property that matters most is
 * that it never carries a credential out of the environment. The rest pins the fields a hung
 * session is diagnosed from.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SPAWN_CONTEXT_FILENAME,
  recordSpawnContext,
} from '@src/integration/ai/providers/_engine/spawn-context-probe.ts';

interface SnapshotShape {
  readonly at: string;
  readonly provider: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdout: { readonly isTTY: boolean };
  readonly stderr: { readonly isTTY: boolean };
  readonly stdin: { readonly listeners: Record<string, unknown> };
  readonly env: { readonly overrideNames: readonly string[] };
}

describe('recordSpawnContext', () => {
  const dirs: string[] = [];
  const makeDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'spawn-context-test-'));
    dirs.push(dir);
    return dir;
  };

  const record = (dir: string, overrides: Record<string, string> | undefined = undefined): SnapshotShape => {
    recordSpawnContext({
      providerName: 'interactive-grok',
      command: 'grok',
      args: ['--no-auto-update', '--cwd', dir],
      cwd: dir,
      outputFile: join(dir, 'output.md'),
      envOverrides: overrides,
    });
    return JSON.parse(readFileSync(join(dir, SPAWN_CONTEXT_FILENAME), 'utf8')) as SnapshotShape;
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('never writes an environment value outside the terminal/runtime allowlist', () => {
    const secret = 'sk-do-not-persist-this-0123456789';
    process.env['SPAWN_PROBE_FAKE_TOKEN'] = secret;
    try {
      const dir = makeDir();
      record(dir);
      const text = readFileSync(join(dir, SPAWN_CONTEXT_FILENAME), 'utf8');
      expect(text).not.toContain(secret);
      // The NAME is kept — that is what makes a present-in-one-spawn-absent-in-another diff work.
      expect(text).toContain('SPAWN_PROBE_FAKE_TOKEN');
    } finally {
      delete process.env['SPAWN_PROBE_FAKE_TOKEN'];
    }
  });

  it('records the argv, cwd and stream state a frozen session is diagnosed from', () => {
    const dir = makeDir();
    const snapshot = record(dir);

    expect(snapshot.provider).toBe('interactive-grok');
    expect(snapshot.command).toBe('grok');
    expect(snapshot.args).toContain('--no-auto-update');
    expect(snapshot.cwd).toBe(dir);
    expect(typeof snapshot.at).toBe('string');
    expect(snapshot.stdout).toHaveProperty('isTTY');
    expect(snapshot.stderr).toHaveProperty('isTTY');
    // The listener counts are the point: a non-zero one means the parent still competes for the
    // terminal the child is about to read.
    expect(snapshot.stdin.listeners).toHaveProperty('data');
    expect(snapshot.stdin.listeners).toHaveProperty('readable');
  });

  it('records env overrides by name only', () => {
    const dir = makeDir();
    const snapshot = record(dir, { OPENCODE_CONFIG_CONTENT: '{"secret":"nope"}' });

    expect(snapshot.env.overrideNames).toEqual(['OPENCODE_CONFIG_CONTENT']);
    expect(readFileSync(join(dir, SPAWN_CONTEXT_FILENAME), 'utf8')).not.toContain('nope');
  });

  it('stays silent when the target directory does not exist — a diagnostic never fails a session', () => {
    expect(() => {
      recordSpawnContext({
        providerName: 'interactive-grok',
        command: 'grok',
        args: [],
        cwd: '/nope',
        outputFile: '/nope/does/not/exist/output.md',
      });
    }).not.toThrow();
  });
});
