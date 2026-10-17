import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCommand } from '@src/integration/io/run-command.ts';
import { backgroundPipeHolder, killQuietly } from '@tests/helpers/process-tree.ts';

describe.skipIf(process.platform === 'win32')('runCommand', () => {
  it('settles on the probe exit when a background job it left still holds the pipes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ralphctl-runcmd-'));
    const pidFile = join(dir, 'holder.pid');
    try {
      // Without a bound after exit this waits for the holder and reads as a 5s probe timeout.
      const result = await runCommand('sh', ['-c', `${backgroundPipeHolder(pidFile)}; echo ready`]);

      expect(result).toEqual({ ok: true, code: 0, stdout: 'ready\n', stderr: '' });
    } finally {
      killQuietly([Number(readFileSync(pidFile, 'utf8').trim())]);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
