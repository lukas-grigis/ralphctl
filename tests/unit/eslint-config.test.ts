import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ESLINT_CONFIG_PATH = join(REPO_ROOT, 'eslint.config.ts');

const ESLINT_CONFIG_TEXT = readFileSync(ESLINT_CONFIG_PATH, 'utf8');

/**
 * Pull a `const <name> = [...] as const;` array out of eslint.config.ts as a sorted set of
 * string literals. Matches both single-line and multi-line shapes. Throws if not found —
 * a missing constant is itself a regression worth surfacing.
 */
const constantFromEslintConfig = (name: string): readonly string[] => {
  const pattern = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\] as const;`, 'm');
  const match = ESLINT_CONFIG_TEXT.match(pattern);
  if (!match) {
    throw new Error(`eslint.config.ts: const ${name} = [...] as const; not found`);
  }
  const body = match[1] ?? '';
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1] as string).sort();
};

const directorySiblings = (relativePath: string, ignoredPrefixes: readonly string[] = []): readonly string[] => {
  const abs = join(REPO_ROOT, relativePath);
  return readdirSync(abs)
    .filter((entry) => statSync(join(abs, entry)).isDirectory())
    .filter((entry) => !ignoredPrefixes.some((prefix) => entry.startsWith(prefix)))
    .sort();
};

describe('eslint.config.ts constants ↔ src/ directory parity', () => {
  it('FLOWS matches src/application/flows/<sibling>/', () => {
    expect(constantFromEslintConfig('FLOWS')).toEqual(directorySiblings('src/application/flows', ['_']));
  });

  it('META_FLOWS matches src/application/flows/_meta/<sibling>/', () => {
    expect(constantFromEslintConfig('META_FLOWS')).toEqual(directorySiblings('src/application/flows/_meta'));
  });

  it('PROMPTS matches src/integration/ai/prompts/<sibling>/ (excluding underscore-prefixed)', () => {
    expect(constantFromEslintConfig('PROMPTS')).toEqual(directorySiblings('src/integration/ai/prompts', ['_']));
  });

  it('PROVIDERS matches src/integration/ai/providers/<sibling>/ (excluding underscore-prefixed)', () => {
    expect(constantFromEslintConfig('PROVIDERS')).toEqual(directorySiblings('src/integration/ai/providers', ['_']));
  });

  it('READINESS_PROVIDERS matches src/integration/ai/readiness/<sibling>/ (excluding underscore-prefixed)', () => {
    expect(constantFromEslintConfig('READINESS_PROVIDERS')).toEqual(
      directorySiblings('src/integration/ai/readiness', ['_'])
    );
  });

  it('SKILLS matches src/integration/ai/skills/<sibling>/ (excluding underscore-prefixed)', () => {
    expect(constantFromEslintConfig('SKILLS')).toEqual(directorySiblings('src/integration/ai/skills', ['_']));
  });

  it('BUSINESS_SIBLINGS matches src/business/<sibling>/ (excluding underscore-prefixed)', () => {
    expect(constantFromEslintConfig('BUSINESS_SIBLINGS')).toEqual(directorySiblings('src/business', ['_']));
  });

  it('REPOSITORY_SIBLINGS matches src/domain/repository/<sibling>/ (excluding underscore-prefixed)', () => {
    expect(constantFromEslintConfig('REPOSITORY_SIBLINGS')).toEqual(directorySiblings('src/domain/repository', ['_']));
  });
});
