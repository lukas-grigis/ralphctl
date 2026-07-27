import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PLACEHOLDER_PATTERN = /\{\{[A-Z][A-Z0-9_]*\}\}/g;

/**
 * Fence: no file under `_partials/` may contain a `{{KEY}}`-shaped placeholder. `buildPrompt`
 * inserts a partial's body as a plain substitution VALUE in the single outer-template pass —
 * that value is never re-scanned, so a placeholder inside a partial body would not be resolved;
 * it would ship as a literal string in the rendered, branded `Prompt`.
 */
describe('partial bodies never contain a {{PLACEHOLDER}}', () => {
  it('scans every file in src/integration/ai/prompts/_partials/ for placeholder-shaped text', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const partialsDir = join(here, '..', '..', '..', '..', '..', 'src', 'integration', 'ai', 'prompts', '_partials');

    const files = (await fs.readdir(partialsDir, { withFileTypes: true }))
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .sort();
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const body = await fs.readFile(join(partialsDir, file), 'utf8');
      const matches = body.match(PLACEHOLDER_PATTERN);
      if (matches) offenders.push(`${file}: ${matches.join(', ')}`);
    }

    if (offenders.length > 0) {
      throw new Error(
        `partial bodies with placeholder-shaped text (would ship as inert literals):\n${offenders.join('\n')}`
      );
    }
    expect(offenders).toHaveLength(0);
  });
});
