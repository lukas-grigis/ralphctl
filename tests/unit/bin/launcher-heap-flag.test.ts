import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const LAUNCHER_PATH = fileURLToPath(new URL('../../../bin/ralphctl', import.meta.url));
const LAUNCHER_TEXT = readFileSync(LAUNCHER_PATH, 'utf8');

describe('bin/ralphctl launcher', () => {
  it('passes --max-old-space-size=8192 to node', () => {
    expect(LAUNCHER_TEXT).toContain('--max-old-space-size=8192');
  });

  it('keeps --max-old-space-size=8192 on the exec node line', () => {
    // Guards against the flag drifting to a stray comment while the active `exec node`
    // invocation runs with the default heap cap — a regression that would only surface
    // under heavy implement-loop traffic.
    expect(LAUNCHER_TEXT).toMatch(/^exec node [^\n]*--max-old-space-size=8192/m);
  });
});
