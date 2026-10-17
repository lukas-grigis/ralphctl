import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCopyToClipboard } from '@src/integration/io/clipboard.ts';
import { pipeSpawn } from '@src/integration/io/cross-platform-spawn.ts';
import { backgroundPipeHolder, killQuietly } from '@tests/helpers/process-tree.ts';

describe.skipIf(process.platform === 'win32')('copyToClipboard with a real helper', () => {
  it('resolves once the helper exits, even when a daemon it forked keeps the pipes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ralphctl-clip-'));
    const pidFile = join(dir, 'daemon.pid');
    // Stands in for `wl-copy`, which forks a background process to serve the selection.
    const copy = createCopyToClipboard({
      platform: 'darwin',
      spawn: (_command, _args, options) =>
        pipeSpawn('sh', ['-c', `cat > /dev/null; ${backgroundPipeHolder(pidFile)}`], options),
    });
    try {
      const result = await copy('hello');

      expect(result.ok).toBe(true);
    } finally {
      killQuietly([Number(readFileSync(pidFile, 'utf8').trim())]);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
