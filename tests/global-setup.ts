import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Run-scoped temp root: every `os.tmpdir()` in workers and spawned children lands here, so a test
// that forgets its cleanup can't leak past the run.
export default function setup(): () => void {
  const root = mkdtempSync(join(tmpdir(), 'ralphctl-vitest-'));
  // POSIX reads TMPDIR; Windows reads TEMP / TMP.
  process.env['TMPDIR'] = root;
  process.env['TMP'] = root;
  process.env['TEMP'] = root;
  return () => rmSync(root, { recursive: true, force: true });
}
