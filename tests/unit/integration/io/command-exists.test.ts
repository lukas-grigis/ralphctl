import { describe, expect, it } from 'vitest';
import { commandExists } from '@src/integration/io/command-exists.ts';

describe('commandExists', () => {
  // `node` is guaranteed on PATH — the test suite itself is running under it. This exercises the
  // real platform-specific probe (`where` on Windows, `command -v` on POSIX) end-to-end, which
  // is the regression that broke Windows launches: the old `command -v` path resolved `false`
  // for every binary under `cmd.exe`.
  it('resolves true for a binary that is on PATH', async () => {
    expect(await commandExists('node')).toBe(true);
  });

  it('resolves false for a binary that is not on PATH', async () => {
    expect(await commandExists('ralphctl-definitely-not-a-real-binary-xyz')).toBe(false);
  });

  it('resolves false (never rejects) for a name with no match', async () => {
    await expect(commandExists('another-missing-binary-9f3a2b')).resolves.toBe(false);
  });
});
