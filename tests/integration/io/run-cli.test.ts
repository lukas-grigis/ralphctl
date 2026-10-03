import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { runCli } from '@src/integration/io/run-cli.ts';
import { pipeSpawn } from '@src/integration/io/cross-platform-spawn.ts';
import type { Spawn } from '@src/integration/io/spawn.ts';

// A child that exits before reading stdin makes the stdin socket emit EPIPE asynchronously.
const epipeChildSpawn: Spawn = () => {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdin = new EventEmitter();
  Object.assign(stdin, {
    end(): void {
      setImmediate(() => {
        stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
        child.emit('close', 1);
      });
    },
  });
  Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin, kill: () => true });
  return child;
};

describe('runCli', () => {
  it('resolves via close when stdin emits EPIPE after the child exits early', async () => {
    const result = await runCli(epipeChildSpawn, 'gh', ['issue', 'comment'], { stdin: 'body', timeoutMs: 5000 });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.exitCode).toBe(1);
  });

  it.skipIf(process.platform === 'win32')(
    'survives a large stdin body to a real child that exits at once',
    async () => {
      const result = await runCli(pipeSpawn, 'sh', ['-c', 'exit 1'], { stdin: 'x'.repeat(2_000_000), timeoutMs: 5000 });

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.exitCode).toBe(1);
    }
  );
});
