/**
 * Template registry fence — catches three drift modes between the on-disk
 * `.md` files, the `TEMPLATE_NAMES` registry, and the source files that load them.
 *
 * (a) A `.md` file lives in `templates/` but is NOT in `TEMPLATE_NAMES`.
 * (b) A `TEMPLATE_NAMES` entry references a `.md` file that does NOT exist.
 * (c) A `TEMPLATE_NAMES` key is defined but never loaded by any
 *     consuming source file (orphan key).
 *
 * Approach for (c): read all source files in the `prompts/` directory
 * synchronously and search for the exact token `TEMPLATE_NAMES.<key>`
 * (followed by a non-identifier character) — every load call goes through
 * this pattern. False-positive accepts (key appears only in a comment) are
 * acceptable; false-negative drift detection (real orphan passes) is not.
 *
 * Note: `TEMPLATE_NAMES` is defined in `prompt-template-names.ts` and is
 * used across both `prompt-builder-adapter.ts` and `prompt-partials-loader.ts`.
 * The scan covers all `.ts` source files in the `prompts/` directory so future
 * refactors that introduce additional consumer files are automatically covered.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TEMPLATE_NAMES } from './prompt-template-names.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(HERE, 'templates');
const PROMPTS_DIR = HERE;

// ─── helpers ────────────────────────────────────────────────────────────────

/** Stem names (without `.md`) of every file currently in `templates/`. */
function diskTemplateStems(): string[] {
  return readdirSync(TEMPLATES_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -'.md'.length));
}

/** Unique `.md` values referenced by `TEMPLATE_NAMES`. */
function registeredTemplateValues(): string[] {
  return [...new Set(Object.values(TEMPLATE_NAMES))];
}

/**
 * Concatenated source of all non-test `.ts` files in the `prompts/`
 * directory. Scanning the whole directory means any future file that uses
 * `TEMPLATE_NAMES` is automatically included without needing to update the
 * test.
 */
function allPromptsSource(): string {
  const files = readdirSync(PROMPTS_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  return files.map((f) => readFileSync(join(PROMPTS_DIR, f), 'utf-8')).join('\n');
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('template registry drift detection', () => {
  it('every .md file in templates/ is registered in TEMPLATE_NAMES', () => {
    const onDisk = diskTemplateStems();
    const registered = registeredTemplateValues();

    const unregistered = onDisk.filter((stem) => !registered.includes(stem));

    // Emit the unregistered stems as the actual value so the diff is readable.
    // Add an entry to TEMPLATE_NAMES in prompt-template-names.ts or delete the file.
    expect(unregistered).toStrictEqual([]);
  });

  it('every TEMPLATE_NAMES entry resolves to an existing .md file', () => {
    const onDisk = new Set(diskTemplateStems());

    const missing: { key: string; value: string }[] = [];
    for (const [key, value] of Object.entries(TEMPLATE_NAMES)) {
      if (!onDisk.has(value)) {
        missing.push({ key, value: `${value}.md` });
      }
    }

    // Each element shows which registry key points to a non-existent file.
    // Either create the template file or remove the registry entry from
    // prompt-template-names.ts.
    expect(missing).toStrictEqual([]);
  });

  it('every TEMPLATE_NAMES key is loaded by at least one source file (no orphan keys)', () => {
    const source = allPromptsSource();

    const orphans: string[] = [];
    for (const key of Object.keys(TEMPLATE_NAMES)) {
      // Use a word-boundary regex so that a short key like `plan` does not
      // match as a prefix of a longer key such as `planInteractive`.
      // The pattern matches `TEMPLATE_NAMES.<key>` only when followed by a
      // non-identifier character (or end of string), preventing prefix
      // collisions. False-positive accepts (e.g., key appears in a comment)
      // are tolerable — false-negative drift detection (orphan passes) is not.
      const pattern = new RegExp(`TEMPLATE_NAMES\\.${key}(?![A-Za-z0-9_])`);
      if (!pattern.test(source)) {
        orphans.push(`TEMPLATE_NAMES.${key} → '${TEMPLATE_NAMES[key as keyof typeof TEMPLATE_NAMES]}'`);
      }
    }

    // Each element names an orphan key that is defined but never loaded.
    // Either reference the key in a loader call or remove it from
    // prompt-template-names.ts.
    expect(orphans).toStrictEqual([]);
  });
});
