import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALL_PROMPT_DEFS } from '@tests/fixtures/prompt-defs.ts';

/**
 * Meta-test: every `src/integration/ai/prompts/<flow>/template.md` MUST be registered in
 * `tests/fixtures/prompt-defs.ts` (which `placeholder-parity.test.ts` and
 * `template-signal-coverage.test.ts` iterate) and have a sibling
 * `tests/integration/ai/prompts/<flow>/definition.test.ts` for its build smoke test.
 */
const here = dirname(fileURLToPath(import.meta.url));
const promptsDir = join(here, '..', '..', '..', '..', 'src', 'integration', 'ai', 'prompts');

const exists = (path: string): Promise<boolean> =>
  fs.access(path).then(
    () => true,
    () => false
  );

describe('prompt template coverage', () => {
  it('every prompt directory is registered in ALL_PROMPT_DEFS and has a colocated definition.test.ts', async () => {
    const dirs = (await fs.readdir(promptsDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
      .map((d) => d.name);
    const flows: string[] = [];
    for (const dir of dirs) if (await exists(join(promptsDir, dir, 'template.md'))) flows.push(dir);

    const registered = new Set(ALL_PROMPT_DEFS.map((def) => def.templateName));
    const missingDef = flows.filter((flow) => !registered.has(flow)).sort();
    const missingTest: string[] = [];
    for (const flow of flows) {
      if (!(await exists(join(here, flow, 'definition.test.ts')))) missingTest.push(flow);
    }

    expect(missingDef, 'flows missing from tests/fixtures/prompt-defs.ts').toEqual([]);
    expect(missingTest, 'flows without a colocated definition.test.ts').toEqual([]);
    expect([...registered].sort()).toEqual([...flows].sort());
  });
});
