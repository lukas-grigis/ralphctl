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

  it('AGENTS matches src/integration/ai/agents/<sibling>/ (excluding underscore-prefixed)', () => {
    expect(constantFromEslintConfig('AGENTS')).toEqual(directorySiblings('src/integration/ai/agents', ['_']));
  });

  it('AI_CONCEPTS matches src/integration/ai/<concept>/ (excluding underscore-prefixed)', () => {
    expect(constantFromEslintConfig('AI_CONCEPTS')).toEqual(directorySiblings('src/integration/ai', ['_']));
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

/**
 * Liveness probes for every no-restricted-imports fence. ESLint flat config REPLACES a
 * same-key rule entry when a later block matches the same file — it never merges options —
 * so a block that narrows a broader glob silently wipes the broader block's restrictions
 * (and vice versa) unless the surviving entry carries the union of both. These probes pin
 * that every fence actually fires in the directories where two blocks overlap; each one was
 * dead (or is the still-live control) when the composition flaw was found.
 */
describe('fence liveness under overlapping config blocks', () => {
  const linter = new Linter();
  const config = eslintConfig as LinterTypes.Config[];

  const restrictedMessages = (code: string, filename: string): string =>
    linter
      .verify(code, config, filename)
      .filter((m) => m.ruleId === 'no-restricted-imports')
      .map((m) => m.message)
      .join('\n');

  const AI_FAMILIES = [
    { constant: 'PROMPTS', root: 'src/integration/ai/prompts' },
    { constant: 'PROVIDERS', root: 'src/integration/ai/providers' },
    { constant: 'READINESS_PROVIDERS', root: 'src/integration/ai/readiness' },
    { constant: 'SKILLS', root: 'src/integration/ai/skills' },
    { constant: 'AGENTS', root: 'src/integration/ai/agents' },
  ] as const;

  for (const { constant, root } of AI_FAMILIES) {
    describe(`${root}/<sibling>/`, () => {
      const [a, b] = constantFromEslintConfig(constant);

      it('sibling isolation fires', () => {
        expect(
          restrictedMessages(
            `import { x } from '@${root}/${b!}/thing.ts';\nexport const y = x;\n`,
            `${root}/${a!}/probe.ts`
          )
        ).toMatch(/Sibling-/);
      });

      it('the integration layer rule survives in a sibling directory', () => {
        expect(
          restrictedMessages(
            "import { x } from '@src/application/registry.ts';\nexport const y = x;\n",
            `${root}/${a!}/probe.ts`
          )
        ).toMatch(/Layer dependency violation/);
      });

      it('the node:child_process spawn fence survives in a sibling directory', () => {
        expect(
          restrictedMessages(
            "import { spawn } from 'node:child_process';\nexport const y = spawn;\n",
            `${root}/${a!}/probe.ts`
          )
        ).toMatch(/child_process/);
      });
    });
  }

  describe('src/business/<sibling>/', () => {
    const [a, b] = constantFromEslintConfig('BUSINESS_SIBLINGS');

    it('sibling isolation fires', () => {
      expect(
        restrictedMessages(
          `import { x } from '@src/business/${b!}/thing.ts';\nexport const y = x;\n`,
          `src/business/${a!}/probe.ts`
        )
      ).toMatch(/Sibling-business/);
    });

    it('the I/O-bearing node module ban survives in a sibling directory', () => {
      expect(
        restrictedMessages(
          "import { readFileSync } from 'node:fs';\nexport const y = readFileSync;\n",
          `src/business/${a!}/probe.ts`
        )
      ).toMatch(/I\/O-bearing/);
    });

    it('the composite *Repository ban survives in a sibling directory', () => {
      expect(
        restrictedMessages(
          "import { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';\nexport const y = 0;\n",
          `src/business/${a!}/probe.ts`
        )
      ).toMatch(/slim sub-ports/);
    });
  });

  describe('src/domain/repository/<sibling>/', () => {
    const [a, b] = constantFromEslintConfig('REPOSITORY_SIBLINGS');

    it('sibling isolation fires', () => {
      expect(
        restrictedMessages(
          `import { x } from '@src/domain/repository/${b!}/thing.ts';\nexport const y = x;\n`,
          `src/domain/repository/${a!}/probe.ts`
        )
      ).toMatch(/Sibling-repository/);
    });

    it('the domain layer rule survives in a sibling directory', () => {
      expect(
        restrictedMessages(
          "import { readFileSync } from 'node:fs';\nexport const y = readFileSync;\n",
          `src/domain/repository/${a!}/probe.ts`
        )
      ).toMatch(/I\/O-bearing|Layer dependency violation/);
    });
  });

  describe('src/application/flows/<flow>/', () => {
    const [a, b] = constantFromEslintConfig('FLOWS');

    it('sibling isolation fires', () => {
      expect(
        restrictedMessages(
          `import { x } from '@src/application/flows/${b!}/flow.ts';\nexport const y = x;\n`,
          `src/application/flows/${a!}/probe.ts`
        )
      ).toMatch(/Sibling-flow/);
    });

    it('the no-concrete-adapters chains rule survives in a sibling directory', () => {
      expect(
        restrictedMessages(
          "import { x } from '@src/integration/ai/providers/claude/headless.ts';\nexport const y = x;\n",
          `src/application/flows/${a!}/probe.ts`
        )
      ).toMatch(/concrete provider adapters/);
    });

    it('bans concrete agent-definition adapters and the agents adapter factory', () => {
      expect(
        restrictedMessages(
          "import { x } from '@src/integration/ai/agents/claude/adapter.ts';\nexport const y = x;\n",
          `src/application/flows/${a!}/probe.ts`
        )
      ).toMatch(/concrete agent-definition adapters/);
      expect(
        restrictedMessages(
          "import { x } from '@src/integration/ai/agents/adapter-factory.ts';\nexport const y = x;\n",
          `src/application/flows/${a!}/probe.ts`
        )
      ).toMatch(/concrete agent-definition adapters/);
    });

    it('allows the agents port namespace', () => {
      expect(
        restrictedMessages(
          "import { x } from '@src/integration/ai/agents/_engine/agent-definition.ts';\nexport const y = x;\n",
          `src/application/flows/${a!}/probe.ts`
        )
      ).toBe('');
    });

    it('bans per-signal schema imports from ordinary flow code', () => {
      expect(
        restrictedMessages(
          "import { x } from '@src/integration/ai/contract/_engine/signals/note/schema.ts';\nexport const y = x;\n",
          `src/application/flows/${a!}/leaves/probe.ts`
        )
      ).toMatch(/per-signal Zod schemas/);
    });

    it('lifts the schema ban for per-leaf *.contract.ts files — the one sanctioned composition point', () => {
      expect(
        restrictedMessages(
          "import { x } from '@src/integration/ai/contract/_engine/signals/note/schema.ts';\nexport const y = x;\n",
          `src/application/flows/${a!}/leaves/probe.contract.ts`
        )
      ).toBe('');
    });

    it('keeps sibling isolation and the concrete-adapter ban inside *.contract.ts files', () => {
      expect(
        restrictedMessages(
          `import { x } from '@src/application/flows/${b!}/flow.ts';\nexport const y = x;\n`,
          `src/application/flows/${a!}/leaves/probe.contract.ts`
        )
      ).toMatch(/Sibling-flow/);
      expect(
        restrictedMessages(
          "import { x } from '@src/integration/ai/providers/claude/headless.ts';\nexport const y = x;\n",
          `src/application/flows/${a!}/leaves/probe.contract.ts`
        )
      ).toMatch(/concrete provider adapters/);
    });
  });

  describe('src/application/chain/** — the kernel layer fence', () => {
    it('bans business imports so the kernel stays ignorant of what it executes', () => {
      expect(
        restrictedMessages(
          "import { x } from '@src/business/task/turn-error-policy.ts';\nexport const y = x;\n",
          'src/application/chain/run/probe.ts'
        )
      ).toMatch(/Layer dependency violation/);
    });

    it('bans integration imports', () => {
      expect(
        restrictedMessages(
          "import { x } from '@src/integration/io/write-file.ts';\nexport const y = x;\n",
          'src/application/chain/run/probe.ts'
        )
      ).toMatch(/Layer dependency violation/);
    });

    it('bans the outer application surfaces that compose over the kernel', () => {
      expect(
        restrictedMessages(
          "import { x } from '@src/application/flows/implement/flow.ts';\nexport const y = x;\n",
          'src/application/chain/probe.ts'
        )
      ).toMatch(/may not import from a flow/);
      expect(
        restrictedMessages(
          "import { x } from '@src/application/ui/shared/launcher.ts';\nexport const y = x;\n",
          'src/application/chain/probe.ts'
        )
      ).toMatch(/may not import from UI/);
      expect(
        restrictedMessages(
          "import { x } from '@src/application/bootstrap/wire.ts';\nexport const y = x;\n",
          'src/application/chain/probe.ts'
        )
      ).toMatch(/composition root/);
    });

    it('allows domain vocabulary and the session scope the runner needs', () => {
      expect(
        restrictedMessages(
          "import { isFatalChainError } from '@src/domain/value/error/is-fatal-chain-error.ts';\nexport const y = isFatalChainError;\n",
          'src/application/chain/run/probe.ts'
        )
      ).toBe('');
      expect(
        restrictedMessages(
          "import { x } from '@src/application/session/session.ts';\nexport const y = x;\n",
          'src/application/chain/run/probe.ts'
        )
      ).toBe('');
    });
  });

  describe('integration/ai/<concept>/ — cross-concept isolation', () => {
    const CONCEPT_SIBLINGS = {
      agents: constantFromEslintConfig('AGENTS'),
      prompts: constantFromEslintConfig('PROMPTS'),
      providers: constantFromEslintConfig('PROVIDERS'),
      readiness: constantFromEslintConfig('READINESS_PROVIDERS'),
      skills: constantFromEslintConfig('SKILLS'),
    } as const;

    const pairs = Object.keys(CONCEPT_SIBLINGS).flatMap((from) =>
      Object.keys(CONCEPT_SIBLINGS)
        .filter((to) => to !== from)
        .map((to) => [from, to] as const)
    );

    for (const [from, to] of pairs) {
      const fromSibling = CONCEPT_SIBLINGS[from as keyof typeof CONCEPT_SIBLINGS][0] as string;
      const toSibling = CONCEPT_SIBLINGS[to as keyof typeof CONCEPT_SIBLINGS][0] as string;

      it(`bans ${from} → ${to}/${toSibling}/ and allows ${from} → ${to}/_engine/`, () => {
        expect(
          restrictedMessages(
            `import { x } from '@src/integration/ai/${to}/${toSibling}/thing.ts';\nexport const y = x;\n`,
            `src/integration/ai/${from}/${fromSibling}/probe.ts`
          )
        ).toMatch(/Cross-concept import violation/);

        expect(
          restrictedMessages(
            `import { x } from '@src/integration/ai/${to}/_engine/thing.ts';\nexport const y = x;\n`,
            `src/integration/ai/${from}/${fromSibling}/probe.ts`
          )
        ).toBe('');
      });
    }

    it('applies to a concept that has no siblings of its own', () => {
      expect(
        restrictedMessages(
          "import { x } from '@src/integration/ai/providers/claude/headless.ts';\nexport const y = x;\n",
          'src/integration/ai/contract/_engine/probe.ts'
        )
      ).toMatch(/Cross-concept import violation/);
    });

    it('leaves a concept free to reach into its own siblings from its root', () => {
      expect(
        restrictedMessages(
          "import { x } from '@src/integration/ai/skills/claude/adapter.ts';\nexport const y = x;\n",
          'src/integration/ai/skills/adapter-factory.ts'
        )
      ).toBe('');
    });
  });
});

/**
 * Liveness probes for the `no-restricted-syntax` fences. Same flat-config replacement hazard as
 * the import fences: a narrower block (the port-shape check under integration/ai/, the class ban
 * under domain/, the reserved-path guard) declares its own selector list and would silently drop
 * the tree-wide barrel and `fs.appendFile` bans for every file it matches unless it composes them
 * back in. These probes pin that each ban still fires in every directory where blocks overlap.
 */
describe('syntax-fence liveness under overlapping config blocks', () => {
  const linter = new Linter();
  const config = eslintConfig as LinterTypes.Config[];

  const syntaxMessages = (code: string, filename: string): string =>
    linter
      .verify(code, config, filename)
      .filter((m) => m.ruleId === 'no-restricted-syntax')
      .map((m) => m.message)
      .join('\n');

  const BARREL = "export * from './other.ts';\n";
  const FS_APPEND = "import fs from 'node:fs';\nexport const x = () => fs.appendFile('a', 'b', () => undefined);\n";
  const FS_PROMISES_APPEND =
    "import fs from 'node:fs';\nexport const x = async () => fs.promises.appendFile('a', 'b');\n";

  // One representative file per directory where a narrower no-restricted-syntax block overlaps
  // the tree-wide bans.
  const OVERLAP_FILES = [
    'src/domain/probe.ts',
    'src/domain/value/error/probe.ts',
    'src/domain/repository/task/probe.ts',
    'src/business/task/probe.ts',
    'src/integration/ai/prompts/plan/probe.ts',
    'src/integration/ai/providers/claude/probe.ts',
    'src/integration/ai/signals/probe.ts',
    'src/application/flows/implement/probe.ts',
  ];

  for (const filename of OVERLAP_FILES) {
    describe(filename, () => {
      it('bans barrel exports', () => {
        expect(syntaxMessages(BARREL, filename)).toMatch(/No barrel exports/);
      });

      it('bans fs.appendFile', () => {
        expect(syntaxMessages(FS_APPEND, filename)).toMatch(/fs\.appendFile is banned/);
      });

      it('bans fs.promises.appendFile', () => {
        expect(syntaxMessages(FS_PROMISES_APPEND, filename)).toMatch(/fs\.promises\.appendFile is banned/);
      });
    });
  }

  it('bans class declarations across domain and business', () => {
    expect(syntaxMessages('export class X {}\n', 'src/domain/probe.ts')).toMatch(/must be modeled as `interface`/);
    expect(syntaxMessages('export class X {}\n', 'src/business/task/probe.ts')).toMatch(
      /must be modeled as `interface`/
    );
  });

  it('lifts only the class ban under src/domain/value/error/', () => {
    expect(syntaxMessages('export class X {}\n', 'src/domain/value/error/probe.ts')).toBe('');
  });

  it('exempts src/integration/io/ from the append ban but not from the barrel ban', () => {
    expect(syntaxMessages(FS_APPEND, 'src/integration/io/probe.ts')).toBe('');
    expect(syntaxMessages(BARREL, 'src/integration/io/probe.ts')).toMatch(/No barrel exports/);
  });

  it('keeps the port-shape check inside an integration/ai sibling directory', () => {
    expect(
      syntaxMessages('export interface ThingAdapter { readonly a: string }\n', 'src/integration/ai/skills/claude/x.ts')
    ).toMatch(/Port-shaped interfaces/);
  });

  it('keeps the reserved-path guard on src/integration/ai/signals/', () => {
    expect(syntaxMessages('export const x = 1;\n', 'src/integration/ai/signals/probe.ts')).toMatch(
      /src\/integration\/ai\/signals\/ is reserved/
    );
  });

  it('keeps the *Output-is-not-a-Result-envelope check under src/business/', () => {
    expect(
      syntaxMessages(
        "import type { Result } from '@src/domain/result.ts';\nexport type FooOutput = Result<string, Error>;\n",
        'src/business/task/probe.ts'
      )
    ).toMatch(/success-side data shape/);
  });
});
