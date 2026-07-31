import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Linter } from 'eslint';
import type { Linter as LinterTypes } from 'eslint';
import eslintConfig from '../../eslint.config.ts';

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

describe('node:child_process spawn/exec fence', () => {
  const linter = new Linter();
  const config = eslintConfig as LinterTypes.Config[];

  const isRestrictedImportError = (messages: readonly LinterTypes.LintMessage[]): boolean =>
    messages.some((m) => m.ruleId === 'no-restricted-imports');

  it('flags a raw spawn import outside the sanctioned wrappers', () => {
    const messages = linter.verify(
      "import { spawn } from 'node:child_process';\nexport const x = () => spawn('echo', []);\n",
      config,
      'src/integration/io/some-new-adapter.ts'
    );
    expect(isRestrictedImportError(messages)).toBe(true);
  });

  it('flags a raw execFile import outside the sanctioned wrappers', () => {
    const messages = linter.verify(
      "import { execFile } from 'node:child_process';\nexport const x = execFile;\n",
      config,
      'src/integration/scm/some-new-adapter.ts'
    );
    expect(isRestrictedImportError(messages)).toBe(true);
  });

  it('does not flag shell-script-runner.ts, the documented shell:true exception', () => {
    const messages = linter.verify(
      "import { spawn } from 'node:child_process';\nexport const x = () => spawn('sh', ['-c', 'echo hi'], { shell: true });\n",
      config,
      'src/integration/io/shell-script-runner.ts'
    );
    expect(isRestrictedImportError(messages)).toBe(false);
  });

  it('does not flag os-notification-dispatcher.ts, the documented promisified-execFile exception', () => {
    const messages = linter.verify(
      "import { execFile } from 'node:child_process';\nexport const x = execFile;\n",
      config,
      'src/integration/observability/os-notification-dispatcher.ts'
    );
    expect(isRestrictedImportError(messages)).toBe(false);
  });

  it('does not flag type-only ChildProcess imports anywhere under integration/', () => {
    const messages = linter.verify(
      "import { type ChildProcess } from 'node:child_process';\nexport type X = ChildProcess;\n",
      config,
      'src/integration/ai/providers/claude/some-adapter.ts'
    );
    expect(isRestrictedImportError(messages)).toBe(false);
  });
});
