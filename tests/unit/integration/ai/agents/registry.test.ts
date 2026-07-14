import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLED_AGENT_DEFINITIONS } from '@src/integration/ai/agents/_engine/registry.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLED_ROOT = join(HERE, '../../../../../src/integration/ai/agents/bundled');

describe('BUNDLED_AGENT_DEFINITIONS', () => {
  it('has at least an evaluator and a generator definition', () => {
    expect(BUNDLED_AGENT_DEFINITIONS).toContain('ralphctl-evaluator');
    expect(BUNDLED_AGENT_DEFINITIONS).toContain('ralphctl-generator');
  });

  it('every name resolves to a bundled <name>.md file on disk', () => {
    for (const name of BUNDLED_AGENT_DEFINITIONS) {
      const path = join(BUNDLED_ROOT, `${name}.md`);
      expect(existsSync(path), `bundled agent definition missing: ${path}`).toBe(true);
    }
  });

  it('namespaces every bundled agent definition name with the ralphctl- prefix', () => {
    for (const name of BUNDLED_AGENT_DEFINITIONS) {
      expect(name.startsWith('ralphctl-'), `bundled agent definition name missing prefix: ${name}`).toBe(true);
    }
  });

  it('has no duplicate names', () => {
    expect(new Set(BUNDLED_AGENT_DEFINITIONS).size).toBe(BUNDLED_AGENT_DEFINITIONS.length);
  });
});
