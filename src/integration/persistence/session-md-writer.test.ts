import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeSessionFinish, writeSessionStart } from './session-md-writer.ts';

let dir: string;

beforeEach(async () => {
  dir = join(tmpdir(), `ralphctl-session-md-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`);
  await mkdir(dir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('writeSessionStart', () => {
  it('writes a frontmatter block followed by the prompt body', async () => {
    const path = join(dir, 'session.md');
    const r = await writeSessionStart({
      path,
      provider: 'claude',
      model: 'claude-opus-4-7',
      cwd: '/tmp/foo',
      flags: ['--add-dir', '/tmp/bar', '--effort', 'xhigh'],
      sessionId: 'sess-abc',
      started: '2026-05-04T10:00:00Z',
      promptBody: 'Hello, agent.',
    });
    expect(r.ok).toBe(true);

    const body = await readFile(path, 'utf-8');
    expect(body).toContain('---\n');
    expect(body).toContain('provider: claude');
    expect(body).toContain('model: claude-opus-4-7');
    expect(body).toContain('cwd: /tmp/foo');
    expect(body).toMatch(/flags: \[--add-dir, \/tmp\/bar, --effort, xhigh\]/);
    expect(body).toContain('sessionId: sess-abc');
    expect(body).toContain('started: 2026-05-04T10:00:00Z');
    expect(body).toContain('## Prompt\n\nHello, agent.');
  });

  it('omits absent optional fields', async () => {
    const path = join(dir, 'session.md');
    await writeSessionStart({
      path,
      provider: 'copilot',
      cwd: '/tmp',
      flags: [],
      started: '2026-05-04T10:00:00Z',
      promptBody: 'X',
    });
    const body = await readFile(path, 'utf-8');
    expect(body).not.toContain('model:');
    expect(body).not.toContain('sessionId:');
    expect(body).toContain('flags: []');
  });

  it('quotes values containing reserved characters (colon followed by space)', async () => {
    const path = join(dir, 'session.md');
    await writeSessionStart({
      path,
      provider: 'claude',
      cwd: '/path with: spaces',
      flags: ['flag with: colon', 'normal'],
      started: '2026-05-04T10:00:00Z',
      promptBody: 'X',
    });
    const body = await readFile(path, 'utf-8');
    expect(body).toContain('cwd: "/path with: spaces"');
    expect(body).toContain('flags: ["flag with: colon", normal]');
  });
});

describe('writeSessionFinish', () => {
  it('preserves the prompt body and updates frontmatter', async () => {
    const path = join(dir, 'session.md');
    await writeSessionStart({
      path,
      provider: 'claude',
      cwd: '/tmp/cwd',
      flags: ['a', 'b'],
      started: '2026-05-04T10:00:00Z',
      promptBody: 'My very specific prompt body.',
    });

    const r = await writeSessionFinish({
      path,
      finished: '2026-05-04T10:05:00Z',
      exitCode: 0,
      sessionId: 'sess-xyz',
    });
    expect(r.ok).toBe(true);

    const body = await readFile(path, 'utf-8');
    expect(body).toContain('finished: 2026-05-04T10:05:00Z');
    expect(body).toContain('exitCode: 0');
    expect(body).toContain('sessionId: sess-xyz');
    // Original keys still present.
    expect(body).toContain('provider: claude');
    expect(body).toContain('started: 2026-05-04T10:00:00Z');
    // Body preserved.
    expect(body).toContain('## Prompt\n\nMy very specific prompt body.');
  });

  it('writes a finish-only stub when no prior file exists', async () => {
    const path = join(dir, 'session.md');
    const r = await writeSessionFinish({
      path,
      finished: '2026-05-04T10:00:00Z',
      exitCode: 1,
    });
    expect(r.ok).toBe(true);
    const body = await readFile(path, 'utf-8');
    expect(body).toContain('finished: 2026-05-04T10:00:00Z');
    expect(body).toContain('exitCode: 1');
    expect(body).toContain('no prompt recorded');
  });

  it('writes exitCode null when null is passed', async () => {
    const path = join(dir, 'session.md');
    await writeSessionStart({
      path,
      provider: 'claude',
      cwd: '/tmp',
      flags: [],
      started: '2026-05-04T10:00:00Z',
      promptBody: 'X',
    });
    await writeSessionFinish({ path, finished: '2026-05-04T10:01:00Z', exitCode: null });
    const body = await readFile(path, 'utf-8');
    expect(body).toContain('exitCode: null');
  });

  it('merges model into the frontmatter on finish (single-write replacement for the legacy patch path)', async () => {
    // Headless spawns learn the resolved model identifier only after the
    // runner returns, so the adapter passes it through SessionFinishArgs.
    // The prior implementation did a second read+regex-rewrite to splice
    // model in; this test pins that the merge happens in one write and
    // co-exists with the standard finish fields.
    const path = join(dir, 'session.md');
    await writeSessionStart({
      path,
      provider: 'claude',
      cwd: '/tmp',
      flags: [],
      started: '2026-05-04T10:00:00Z',
      promptBody: 'X',
    });
    await writeSessionFinish({
      path,
      finished: '2026-05-04T10:01:00Z',
      exitCode: 0,
      sessionId: 'sess-merge',
      model: 'claude-opus-4-7',
    });
    const body = await readFile(path, 'utf-8');
    expect(body).toContain('model: claude-opus-4-7');
    expect(body).toContain('sessionId: sess-merge');
    expect(body).toContain('exitCode: 0');
    // Body still preserved.
    expect(body).toContain('## Prompt\n\nX');
  });

  it('includes model in the finish-only stub when no prior file exists', async () => {
    const path = join(dir, 'session.md');
    await writeSessionFinish({
      path,
      finished: '2026-05-04T10:00:00Z',
      exitCode: 0,
      model: 'claude-opus-4-7',
    });
    const body = await readFile(path, 'utf-8');
    expect(body).toContain('model: claude-opus-4-7');
    expect(body).toContain('finished: 2026-05-04T10:00:00Z');
  });
});
