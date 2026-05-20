import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Forensic assertion: the legacy streaming `progress-file-sink` and its companion
 * `flush-progress-sink` leaf have been deleted (P1c). If a future change accidentally
 * re-introduces either file, this test fails fast so the snapshot renderer policy is not
 * silently bypassed.
 */
describe('legacy progress-file-sink removal', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '..', '..', '..', '..');

  it('integration/observability/sinks/progress-file-sink.ts is gone', () => {
    expect(existsSync(resolve(repoRoot, 'src/integration/observability/sinks/progress-file-sink.ts'))).toBe(false);
  });

  it('application/flows/implement/leaves/flush-progress-sink.ts is gone', () => {
    expect(existsSync(resolve(repoRoot, 'src/application/flows/implement/leaves/flush-progress-sink.ts'))).toBe(false);
  });
});
