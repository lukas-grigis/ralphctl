import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';

// Sandbox the persistence root BEFORE any test imports a persistence module.
// CLAUDE.md mandates this ordering; setupFiles run prior to the test files
// in each worker so environment writes here propagate to subsequent imports.
// Tests that already set RALPHCTL_ROOT explicitly keep their value — we only
// seed the default.
if (!process.env['RALPHCTL_ROOT']) {
  const testRoot = mkdtempSync(join(tmpdir(), 'ralphctl-test-'));
  process.env['RALPHCTL_ROOT'] = testRoot;

  process.on('exit', () => {
    if (existsSync(testRoot)) {
      try {
        rmSync(testRoot, { recursive: true, force: true });
      } catch {
        // Best-effort — process is exiting anyway.
      }
    }
  });
}

process.env['RALPHCTL_LOG_LEVEL'] ??= 'error';

// Strip ANSI escape codes when snapshotting Ink frames so palette / glyph
// tweaks don't churn diffs. Pattern is the canonical strip-ansi regex.
const ANSI_PATTERN = new RegExp(
  [
    '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)',
    '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))',
  ].join('|'),
  'g'
);

const ESCAPE = '';

expect.addSnapshotSerializer({
  test: (val) => typeof val === 'string' && val.includes(ESCAPE),
  serialize: (val) => `"${(val as string).replace(ANSI_PATTERN, '')}"`,
});
