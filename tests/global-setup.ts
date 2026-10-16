import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Run-scoped temp root: every `os.tmpdir()` in workers and spawned children lands here, so a test
// that forgets its cleanup can't leak past the run.
export default function setup(): () => void {
  const root = mkdtempSync(join(tmpdir(), 'ralphctl-vitest-'));
  const previous = { TMPDIR: process.env['TMPDIR'], TMP: process.env['TMP'], TEMP: process.env['TEMP'] };
  // POSIX reads TMPDIR; Windows reads TEMP / TMP.
  process.env['TMPDIR'] = root;
  process.env['TMP'] = root;
  process.env['TEMP'] = root;
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  };
}
