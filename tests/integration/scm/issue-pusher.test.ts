import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createIssuePusher } from '@src/integration/scm/issue-pusher.ts';
import type { Spawn } from '@src/integration/io/spawn.ts';

interface ScriptedResponse {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdout: string;
  readonly stderr?: string;
  readonly exitCode: number;
}

interface SpawnCapture {
  readonly stdinWrites: string[];
}

const scriptedSpawn = (responses: readonly ScriptedResponse[]): { spawn: Spawn; capture: SpawnCapture } => {
  let i = 0;
  const stdinWrites: string[] = [];
  const spawn: Spawn = (command, args) => {
    const next = responses[i++];
    if (!next) throw new Error(`unscripted spawn ${command} ${args.join(' ')}`);
    if (next.command !== command || JSON.stringify(next.args) !== JSON.stringify([...args])) {
      throw new Error(`expected ${next.command} ${next.args.join(' ')} got ${command} ${args.join(' ')}`);
    }
    return makeChild(next.stdout, next.stderr ?? '', next.exitCode, stdinWrites);
  };
  return { spawn, capture: { stdinWrites } };
};

const makeChild = (
  stdout: string,
  stderr: string,
  exitCode: number,
  stdinWrites: string[]
): ChildProcessWithoutNullStreams => {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdoutStream = new EventEmitter() as ChildProcessWithoutNullStreams['stdout'];
  const stderrStream = new EventEmitter() as ChildProcessWithoutNullStreams['stderr'];
  Object.assign(child, {
    stdout: stdoutStream,
    stderr: stderrStream,
    stdin: {
      end(payload?: string): void {
        if (payload !== undefined) stdinWrites.push(payload);
      },
    },
    kill(): boolean {
      return true;
    },
  });
  setImmediate(() => {
    if (stdout) stdoutStream.emit('data', Buffer.from(stdout, 'utf8'));
    if (stderr) stderrStream.emit('data', Buffer.from(stderr, 'utf8'));
    setImmediate(() => child.emit('close', exitCode));
  });
  return child;
};

describe('createIssuePusher — comment', () => {
  it('GitHub: dispatches to `gh issue comment` with body on stdin', async () => {
    const { spawn, capture } = scriptedSpawn([
      {
        command: 'gh',
        args: ['issue', 'comment', '42', '--repo', 'x/y', '--body-file', '-'],
        stdout: '',
        exitCode: 0,
      },
    ]);
    const pusher = createIssuePusher({ spawn });
    const r = await pusher.comment('https://github.com/x/y/issues/42', { body: 'new body' });
    expect(r.ok).toBe(true);
    expect(capture.stdinWrites).toEqual(['new body']);
  });

  it('GitLab: dispatches to `glab issue comment` with --body flag', async () => {
    const { spawn, capture } = scriptedSpawn([
      {
        command: 'glab',
        args: ['issue', 'comment', '7', '--repo', 'gitlab.com/foo/bar', '--body', 'new body'],
        stdout: '',
        exitCode: 0,
      },
    ]);
    const pusher = createIssuePusher({ spawn });
    const r = await pusher.comment('https://gitlab.com/foo/bar/-/issues/7', { body: 'new body' });
    expect(r.ok).toBe(true);
    // glab takes the body as a flag value, not on stdin.
    expect(capture.stdinWrites).toEqual([]);
  });

  it('self-hosted GitLab: prefixes the URL host onto glab --repo', async () => {
    const { spawn } = scriptedSpawn([
      {
        command: 'glab',
        args: ['issue', 'comment', '55', '--repo', 'gitlab.example.internal/team/project', '--body', 'done'],
        stdout: '',
        exitCode: 0,
      },
    ]);
    const pusher = createIssuePusher({ spawn });
    const r = await pusher.comment('https://gitlab.example.internal/team/project/-/work_items/55', { body: 'done' });
    expect(r.ok).toBe(true);
  });

  it('rejects unsupported issue URLs with a parse error', async () => {
    const { spawn } = scriptedSpawn([]);
    const pusher = createIssuePusher({ spawn });
    const r = await pusher.comment('https://example.com/not-an-issue', { body: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/unsupported issue URL/);
  });

  it('surfaces a CLI non-zero exit as a StorageError', async () => {
    const { spawn } = scriptedSpawn([
      {
        command: 'gh',
        args: ['issue', 'comment', '42', '--repo', 'x/y', '--body-file', '-'],
        stdout: '',
        stderr: 'gh: not authenticated',
        exitCode: 1,
      },
    ]);
    const pusher = createIssuePusher({ spawn });
    const r = await pusher.comment('https://github.com/x/y/issues/42', { body: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/gh issue comment failed.*not authenticated/);
  });
});
