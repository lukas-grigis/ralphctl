import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import { READ_ONLY } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { createMockHeadlessProvider, type SpawnFixture } from '@tests/helpers/mock-headless-provider.ts';

const absolutePath = (p: string): AbsolutePath => {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error(`bad path: ${p}`);
  return r.value;
};

const buildSession = (signalsFile: AbsolutePath, cwd: AbsolutePath): AiSession => ({
  prompt: 'fake prompt body' as Prompt,
  cwd,
  model: 'mock-model',
  permissions: READ_ONLY,
  signalsFile,
});

describe('createMockHeadlessProvider', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ralphctl-mock-prov-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes signals.json on ok fixture', async () => {
    const signalsFile = absolutePath(join(dir, 'signals.json'));
    const cwd = absolutePath(dir);
    const fixture: SpawnFixture = {
      kind: 'ok',
      payload: { schemaVersion: 1, signals: [{ type: 'note', text: 'hi', timestamp: '2026-05-22T10:00:00.000Z' }] },
      sessionId: 'sess-abc',
    };
    const mock = createMockHeadlessProvider({
      fixtures: new Map([[String(signalsFile), fixture]]),
    });

    const result = await mock.provider.generate(buildSession(signalsFile, cwd));
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.sessionId).toBe('sess-abc');
    expect(result.value.exitCode).toBe(0);
    expect(existsSync(String(signalsFile))).toBe(true);
    const parsed = JSON.parse(readFileSync(String(signalsFile), 'utf8'));
    expect(parsed.signals[0].type).toBe('note');
  });

  it('writes nothing on ok-missing', async () => {
    const signalsFile = absolutePath(join(dir, 'signals.json'));
    const cwd = absolutePath(dir);
    const mock = createMockHeadlessProvider({
      fixtures: new Map([[String(signalsFile), { kind: 'ok-missing' } as SpawnFixture]]),
    });
    const result = await mock.provider.generate(buildSession(signalsFile, cwd));
    expect(result.ok).toBe(true);
    expect(existsSync(String(signalsFile))).toBe(false);
  });

  it('writes raw bytes on ok-raw (for invalid-JSON tests)', async () => {
    const signalsFile = absolutePath(join(dir, 'signals.json'));
    const cwd = absolutePath(dir);
    const mock = createMockHeadlessProvider({
      fixtures: new Map([[String(signalsFile), { kind: 'ok-raw', rawBody: '{ not json' } as SpawnFixture]]),
    });
    const result = await mock.provider.generate(buildSession(signalsFile, cwd));
    expect(result.ok).toBe(true);
    expect(readFileSync(String(signalsFile), 'utf8')).toBe('{ not json');
  });

  it('returns Result.error on spawn-error fixture', async () => {
    const signalsFile = absolutePath(join(dir, 'signals.json'));
    const cwd = absolutePath(dir);
    const err = new StorageError({ subCode: 'io', message: 'disk full' });
    const mock = createMockHeadlessProvider({
      fixtures: new Map([[String(signalsFile), { kind: 'spawn-error', error: err }]]),
    });
    const result = await mock.provider.generate(buildSession(signalsFile, cwd));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(err);
    expect(existsSync(String(signalsFile))).toBe(false);
  });

  it('throws AbortError on abort fixture', async () => {
    const signalsFile = absolutePath(join(dir, 'signals.json'));
    const cwd = absolutePath(dir);
    const mock = createMockHeadlessProvider({
      fixtures: new Map([[String(signalsFile), { kind: 'abort' }]]),
    });
    await expect(mock.provider.generate(buildSession(signalsFile, cwd))).rejects.toBeInstanceOf(AbortError);
  });

  it('throws a clear error when no fixture is registered for the signalsFile', async () => {
    const signalsFile = absolutePath(join(dir, 'signals.json'));
    const cwd = absolutePath(dir);
    const mock = createMockHeadlessProvider({ fixtures: new Map() });
    await expect(mock.provider.generate(buildSession(signalsFile, cwd))).rejects.toThrow(/no fixture registered/);
  });

  it('records invocations in call order', async () => {
    const sig1 = absolutePath(join(dir, 'a/signals.json'));
    const sig2 = absolutePath(join(dir, 'b/signals.json'));
    const cwd = absolutePath(dir);
    const mock = createMockHeadlessProvider({
      fixtures: new Map<string, SpawnFixture>([
        [String(sig1), { kind: 'ok', payload: { schemaVersion: 1, signals: [] } }],
        [String(sig2), { kind: 'ok-missing' }],
      ]),
    });
    await mock.provider.generate(buildSession(sig1, cwd));
    await mock.provider.generate(buildSession(sig2, cwd));
    expect(mock.invocations.map((r) => String(r.signalsFile))).toEqual([String(sig1), String(sig2)]);
  });
});
