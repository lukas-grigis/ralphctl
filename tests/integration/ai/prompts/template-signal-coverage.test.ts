import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALL_PROMPT_DEFS } from '@tests/fixtures/prompt-defs.ts';

/**
 * Meta-test: every signal kind a flow's `expectedSignals` advertises MUST be mentioned at least
 * once in that flow's template body. Catches the drift where the contract advertises a signal
 * but the template forgot to instruct the AI to emit it — the AI then never produces it and the
 * harness silently degrades.
 *
 * Mention forms recognised:
 *   - Backticked signal name:   `task-complete`
 *   - Inline tag form:          <task-complete>...</task-complete> (open, close, or with attributes)
 *   - Backticked tag form:      `<task-complete>`
 *
 * The check is a substring scan against the rendered template plus its `_partials/` includes;
 * the auto-rendered `{{OUTPUT_CONTRACT_SECTION}}` block is composed at runtime by the contract
 * pipeline and is not visible here. That section names every signal in `expectedSignals` by
 * construction, so it's safe to treat as a constant satisfier — this test focuses on whether
 * the template body itself reinforces the contract.
 */

const here = dirname(fileURLToPath(import.meta.url));
const promptsDir = join(here, '..', '..', '..', '..', 'src', 'integration', 'ai', 'prompts');

const loadTemplateWithPartials = async (flow: string, partialNames: readonly string[]): Promise<string> => {
  const template = await fs.readFile(join(promptsDir, flow, 'template.md'), 'utf8');
  const partialBodies = await Promise.all(
    partialNames.map((name) => fs.readFile(join(promptsDir, '_partials', `${name}.md`), 'utf8'))
  );
  return [template, ...partialBodies].join('\n');
};

/**
 * Per-flow allowlist of signals expected to be absent from the template body — empty by
 * default. Use only as a documented escape hatch when a flow advertises a signal that's
 * legitimately emitted by harness-rendered prose rather than the template author's text.
 */
const PRE_EXISTING_GAPS: Readonly<Record<string, ReadonlySet<string>>> = {};

describe('prompt template signal coverage', () => {
  for (const def of ALL_PROMPT_DEFS) {
    const name = def.templateName;
    it(`${name}: every expectedSignals entry is mentioned at least once in the template body`, async () => {
      const partialNames = Object.values(def.partials ?? {});
      const body = await loadTemplateWithPartials(name, partialNames);
      const ignored = PRE_EXISTING_GAPS[name] ?? new Set<string>();

      const missing: string[] = [];
      for (const signal of def.expectedSignals) {
        if (ignored.has(signal)) continue;
        // Match the signal name as a backticked token or an XML-tag form (open, close, or with attributes).
        const patterns = [`\`${signal}\``, `<${signal}>`, `<${signal} `, `</${signal}>`, `\`<${signal}>\``];
        const found = patterns.some((p) => body.includes(p));
        if (!found) missing.push(signal);
      }

      if (missing.length > 0) {
        throw new Error(
          `${name}: template body never mentions these signals listed in expectedSignals: ${missing.join(', ')}. ` +
            `Either name them in the prose (so the AI knows to emit them) or remove them from expectedSignals.`
        );
      }
      expect(missing).toHaveLength(0);
    });
  }
});
