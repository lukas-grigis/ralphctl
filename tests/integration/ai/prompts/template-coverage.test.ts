import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Meta-test: every `src/integration/ai/prompts/<flow>/template.md` MUST have a sibling
 * `tests/integration/ai/prompts/<flow>/definition.test.ts`. This is the project's stand-in
 * for an ESLint rule per audit [11] — the same enforcement (catch missing tests at PR time)
 * is provided by the existing `pnpm test` gate, so a custom plugin isn't required.
 *
 * Failure here means a new prompt flow was added without its parity test. Add a
 * `definition.test.ts` next to the existing per-flow tests with at minimum:
 *   - placeholder ↔ parameter parity (both directions)
 *   - a smoke build of the prompt against `defaultTemplatesDir()`
 */
describe('prompt template coverage', () => {
  it('every prompt directory has a colocated definition.test.ts', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const promptsDir = join(here, '..', '..', '..', '..', 'src', 'integration', 'ai', 'prompts');
    const testsDir = here;

    const flows = (await fs.readdir(promptsDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .filter((d) => !d.name.startsWith('_'))
      .map((d) => d.name)
      .sort();

    const missing: string[] = [];
    for (const flow of flows) {
      const promptTemplatePath = join(promptsDir, flow, 'template.md');
      try {
        await fs.access(promptTemplatePath);
      } catch {
        // No template.md in this directory — not a prompt flow.
        continue;
      }
      const definitionTestPath = join(testsDir, flow, 'definition.test.ts');
      try {
        await fs.access(definitionTestPath);
      } catch {
        missing.push(`${flow} (expected ${definitionTestPath})`);
      }
    }

    if (missing.length > 0) {
      const list = missing.map((m) => `  - ${m}`).join('\n');
      throw new Error(`prompt flows without a colocated definition.test.ts:\n${list}`);
    }
    expect(missing).toHaveLength(0);
  });
});
