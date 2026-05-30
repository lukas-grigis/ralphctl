import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import sonarjs from 'eslint-plugin-sonarjs';
import type { ESLint, Linter } from 'eslint';

/**
 * Layer rules.
 *
 *   domain → nothing                                    (entities + repositories + value objects + validation;
 *                                                        no third-party libs except typescript-result via
 *                                                        the single re-export point and zod for parsers)
 *   business → domain                                   (use cases as `(props) => Promise<Output>` with named
 *                                                        Props interfaces; no I/O-bearing node modules, no
 *                                                        chain-framework imports, no AI imports — deps are
 *                                                        inline function shapes that integration supplies)
 *   integration → domain, business                      (concrete impls — persistence, scm, ai (providers,
 *                                                        prompts, signals, skills, readiness probes), I/O +
 *                                                        shell wrappers, observability sinks)
 *   application → everything                            (chain framework + flow compositions + composition
 *                                                        root + UI runtime; wires business use cases via
 *                                                        chain leaves that adapt to integration impls)
 *
 * Sub-layer rules inside application:
 *
 *   application/flows/** may not import concrete provider/probe/skill impls under integration/ai/
 *   — chain compositions speak port-level vocabulary only; bootstrap selects the concrete impls.
 *
 * Sibling rules (enforced via per-folder overrides at the bottom):
 *
 *   integration/ai/prompts/<x>    may not import from integration/ai/prompts/<y>
 *   integration/ai/signals/<x>    may not import from integration/ai/signals/<y>
 *   integration/ai/providers/<x>  may not import from integration/ai/providers/<y>
 *   integration/ai/readiness/<x>  may not import from integration/ai/readiness/<y>
 *   integration/ai/skills/<x>     may not import from integration/ai/skills/<y>
 *                                 (skills siblings cover both per-tool adapter
 *                                  implementations and Skill source providers — the
 *                                  one switch over them is `skills/adapter-factory.ts`,
 *                                  which sits directly under skills/ and is not a sibling)
 *   application/flows/<x>       may not import from application/flows/<y>
 *   application/flows/_meta/<x> may not import from application/flows/_meta/<y>
 *                                                              (meta-flows MAY import any flows/<y>)
 *
 *   In each AI concept, the `_engine/` sub-namespace is the shared abstraction layer — every concrete
 *   sibling may import freely from its own `_engine/`. Cross-concept access goes through the other
 *   concept's `_engine/` (e.g. integration/ai/prompts/refine may import integration/ai/signals/_engine/
 *   signal.ts to declare expected signals on a prompt definition).
 *
 * Module-level rules:
 *
 *   No barrel exports (export * from ...) anywhere — every import names what it pulls in.
 *   Domain + business may not import I/O-bearing node:* modules (fs, child_process, http, ...).
 *   Pure node:* modules (node:path, node:url, node:util, node:assert, node:crypto) are fine.
 *   AI may use I/O-bearing node:* modules — it owns the provider/template/skill I/O.
 */

const restrictImports = (forbidden: readonly string[]): Linter.RuleEntry => [
  'error',
  {
    patterns: forbidden.map((layer) => ({
      group: [`**/${layer}/**`],
      message: `Layer dependency violation: cannot import from '${layer}'.`,
    })),
  },
];

/**
 * The Result re-export point is the only file allowed to import `typescript-result` directly.
 * Everything else imports from `@src/domain/result.ts` so the underlying library can be swapped
 * without churning every file.
 */
const resultLibBan = {
  name: 'typescript-result',
  message:
    "Import `Result` from '@src/domain/result.ts' (the single re-export point) instead. The underlying `typescript-result` library may only be imported by that one file so the implementation can be swapped without churning callers.",
} as const;

/**
 * Node modules that perform I/O or expose host-environment state. Banned in domain + business so
 * the product model stays portable + testable without a node runtime. Integration / ai may
 * import these freely (they own the impure side).
 *
 * Allowed in domain + business (pure modules): node:path, node:url (parsing only), node:util,
 * node:assert, node:crypto.
 */
const nodeIoBans = [
  'node:fs',
  'node:fs/promises',
  'node:child_process',
  'node:http',
  'node:https',
  'node:net',
  'node:dgram',
  'node:dns',
  'node:os',
  'node:tty',
  'node:readline',
  'node:repl',
  'node:stream',
  'node:cluster',
  'node:worker_threads',
  'node:perf_hooks',
].map((name) => ({
  name,
  message: `Domain + business may not import I/O-bearing node modules — '${name}' belongs in integration/ or ai/.`,
}));

/**
 * Build a `no-restricted-imports` entry for a sibling-isolation rule. Each item under
 * `<rootGlob>/<sibling>/` may only import from itself (the active sibling) or from any of the
 * `allowedSiblings` (e.g. underscore-prefixed sub-namespaces like `_engine` / `_partials`).
 *
 * The rule lists every OTHER sibling explicitly so the patterns stay minimatch-compatible
 * (no extglob negation needed — extglob coverage in ESLint's minimatch varies by version).
 */
const siblingIsolationRule = (
  rootGlob: string,
  active: string,
  allSiblings: readonly string[],
  allowedSiblings: readonly string[],
  noun: string
): Linter.RuleEntry => {
  const forbidden = allSiblings.filter((s) => s !== active && !allowedSiblings.includes(s));
  return [
    'error',
    {
      paths: [resultLibBan],
      patterns: forbidden.map((sibling) => ({
        group: [`${rootGlob}/${sibling}/**`],
        message: `Sibling-${noun} import violation: '${active}' may not reach into '${sibling}'. Each ${noun} is independent; share via the _engine/ sub-namespace instead.`,
      })),
    },
  ];
};

const FLOWS = [
  'add-tickets',
  'close-sprint',
  'create-pr',
  'create-sprint',
  'detect-scripts',
  'detect-skills',
  'doctor',
  'export-context',
  'export-requirements',
  'ideate',
  'implement',
  'readiness',
  'plan',
  'refine',
  'review',
  'settings',
  'settings-apply-preset',
  'settings-set',
  'settings-set-provider',
  'settings-show',
  'ticket-add',
  'ticket-remove',
] as const;

const META_FLOWS = ['run'] as const;

const PROMPTS = [
  'apply-feedback',
  'create-pr',
  'detect-scripts',
  'detect-skills',
  'distill-learnings',
  'evaluate',
  'ideate',
  'implement',
  'plan',
  'readiness',
  'refine',
] as const;

const BUSINESS_SIBLINGS = [
  'feedback',
  'interactive',
  'io',
  'observability',
  'project',
  'scm',
  'settings',
  'sprint',
  'task',
  'ticket',
  'version',
] as const;

const REPOSITORY_SIBLINGS = ['project', 'settings', 'sprint', 'task'] as const;

const PROVIDERS = ['claude', 'codex', 'copilot'] as const;

const READINESS_PROVIDERS = ['claude', 'codex', 'copilot'] as const;

/**
 * Sibling concretes under integration/ai/skills/. Mixes two roles intentionally:
 *  - per-tool adapter directories (`claude`, `codex`, `copilot`) implementing `SkillsAdapter`
 *  - skill-source directories (`bundled`, `project`) implementing `SkillSource`
 * Both kinds belong to the same `skills/` concept and share `_engine/` for contracts and helpers.
 * Cross-sibling reach goes through `skills/_engine/`; the composition switch over the per-tool
 * adapters lives at `skills/adapter-factory.ts`, which is not itself a sibling.
 */
const SKILLS = ['bundled', 'claude', 'codex', 'copilot', 'project'] as const;

/**
 * Domain layer rule. Pure entities + value objects + errors + Result + observability interfaces.
 * May import nothing outside src/domain/. May not import I/O-bearing node modules — domain is
 * the purest layer. Pure node modules (node:path, node:url, ...) remain allowed.
 */
const domainLayerRule: Linter.RuleEntry = [
  'error',
  {
    paths: [resultLibBan, ...nodeIoBans],
    patterns: ['business', 'ai', 'integration', 'application'].map((layer) => ({
      group: [`**/${layer}/**`],
      message: `Layer dependency violation: domain must not import from '${layer}'.`,
    })),
  },
];

/**
 * Business layer rule. Bans I/O-bearing node modules and upper layers. May import from domain,
 * business (itself), and ai. The chain framework lives in application/, so business is
 * structurally prevented from depending on chains, leaves, or flow composition.
 *
 * Also bans composite `*Repository` imports — business use cases depend on the slim sub-ports
 * (`FindById`, `Save`, `Remove`, etc.) from `domain/repository/_base/` so each use case is
 * legible from its dependencies, and persistence adapters can implement narrower interfaces.
 */
const businessLayerRule: Linter.RuleEntry = [
  'error',
  {
    paths: [resultLibBan, ...nodeIoBans],
    patterns: [
      ...['integration', 'application'].map((layer) => ({
        group: [`**/${layer}/**`],
        message: `Layer dependency violation: cannot import from '${layer}'.`,
      })),
      {
        group: ['**/domain/repository/*/!(_base)*-repository*', '**/domain/repository/*/*-repository*'],
        importNames: [
          'ProjectRepository',
          'SprintRepository',
          'SprintExecutionRepository',
          'TaskRepository',
          'SettingsRepository',
        ],
        message:
          'Business use cases must depend on the slim sub-ports under domain/repository/_base/ (FindById, Save, Remove, ...) — not on composite `*Repository` interfaces. Composition root in application/bootstrap wires the composite to the use case as a slim port.',
      },
    ],
  },
];

/**
 * Sub-rule for application/flows/** — chain compositions (regular flows, _meta composers, and
 * _shared Element factories). May depend freely on domain, business, ai (port level), and the
 * chain framework, but NOT on concrete provider / readiness-probe / skill-adapter impls — those
 * are picked by the composition root. Chain compositions speak only port-level vocabulary so
 * the provider can be swapped without changing flow code.
 */
const chainsLayerRule: Linter.RuleEntry = [
  'error',
  {
    paths: [resultLibBan],
    patterns: [
      { group: ['**/application/ui/**'], message: 'Chains may not import from UI.' },
      { group: ['**/application/bootstrap/**'], message: 'Chains may not import from bootstrap.' },
      {
        group: PROVIDERS.map((p) => `**/integration/ai/providers/${p}/**`),
        message:
          'Chains may not import concrete provider adapters — depend on integration/ai/providers/_engine/ port instead. Bootstrap selects the concrete provider.',
      },
      {
        group: READINESS_PROVIDERS.map((p) => `**/integration/ai/readiness/${p}/**`),
        message:
          'Chains may not import concrete readiness probes — depend on integration/ai/readiness/_engine/ port instead. Bootstrap wires concrete probes.',
      },
      {
        group: [
          ...SKILLS.map((s) => `**/integration/ai/skills/${s}/**`),
          '**/integration/ai/skills/adapter-factory.ts',
        ],
        message:
          'Chains may not import concrete skill adapters / sources — depend on integration/ai/skills/_engine/ ports instead. Bootstrap selects concrete skills.',
      },
      {
        group: ['**/integration/ai/contract/_engine/signals/**'],
        message:
          'Chains may not import per-signal Zod schemas directly — go through the leaf contract (validateSignalsFile / renderSidecars / renderContractSection) under integration/ai/contract/_engine/. Per-signal schemas are private to the contract engine.',
      },
    ],
  },
];

/**
 * Ban direct `fs.appendFile` / `fs.promises.appendFile` calls outside `integration/io/`. The
 * harness routes every append-stream write through the `AppendFile` port (audit-[07]); a
 * stray `fs.appendFile` would silently bypass the atomicity + structured-error guarantees
 * the port adds. Matches both `fs.appendFile(...)` and `fs.promises.appendFile(...)` shapes.
 */
const noFsAppendFile: Linter.RuleEntry = [
  'error',
  {
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.property.name='appendFile'][callee.object.name='fs']",
    message: 'fs.appendFile is banned outside integration/io/ — go through the AppendFile port instead.',
  },
  {
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.property.name='appendFile'][callee.object.type='MemberExpression'][callee.object.property.name='promises']",
    message: 'fs.promises.appendFile is banned outside integration/io/ — go through the AppendFile port instead.',
  },
];

/** Disallow `class` declarations across the domain + business layers. Errors under src/domain/value/error/ are exempt. */
const noClassInDomainOrBusiness: Linter.RuleEntry = [
  'error',
  {
    selector: 'ClassDeclaration',
    message:
      'Domain + business types must be modeled as `interface` + standalone functions, not classes. Errors live under src/domain/value/error/.',
  },
];

/**
 * No barrel exports anywhere under src/. Every importer names what it pulls in directly so
 * "where does symbol X come from" is one click away — no chasing re-export chains.
 */
const noBarrels: Linter.RuleEntry = [
  'error',
  {
    selector: 'ExportAllDeclaration',
    message: 'No barrel exports — every import must name what it pulls in directly.',
  },
];

export default [
  {
    ignores: ['dist/**', 'node_modules/**', '.claude/worktrees/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
  },

  // ── memory-leak + correctness hygiene plugins ─────────────────────────────────
  // `react-hooks/rules-of-hooks` is the plugin that surfaced the conditional-Hook bug
  // in execute-view.tsx (suspected root of the recurring 8h OOM). `exhaustive-deps`
  // catches stale closures that retain references across re-renders. The sonarjs
  // subset is a cheap collection-correctness net for the same class of slow leaks.
  //
  // react-hooks's exported Plugin type doesn't align with `Linter.Config['plugins']`
  // under `exactOptionalPropertyTypes`, so we cast once at the boundary — the rules
  // themselves are still type-checked through ESLint's runtime config validator.
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks as unknown as ESLint.Plugin,
      sonarjs: sonarjs as unknown as ESLint.Plugin,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'sonarjs/no-unused-collection': 'warn',
      'sonarjs/no-ignored-return': 'warn',
      'sonarjs/no-element-overwrite': 'warn',
      'sonarjs/no-identical-conditions': 'warn',
      'sonarjs/no-collection-size-mischeck': 'warn',
      // ── SonarQube-style maintainability rules (warn-only, calibrated) ─────
      // These surface long-running drift without blocking. The B-group TUI splits
      // will mop up the bulk of the warnings; they're intentionally not errors so
      // refactor work can land incrementally.
      'sonarjs/cognitive-complexity': ['warn', 15],
      'sonarjs/no-duplicate-string': 'warn',
      'sonarjs/no-identical-functions': 'warn',
      'sonarjs/no-collapsible-if': 'warn',
      'sonarjs/no-redundant-jump': 'warn',
      'sonarjs/prefer-immediate-return': 'warn',
    },
  },

  // ── core ESLint size + complexity rules (warn-only) ──────────────────────────
  // Calibrated thresholds: complexity 15 (matches sonarjs/cognitive-complexity);
  // max-lines-per-function 80; max-lines 400 per file. Tests are exempted from
  // size limits because table-driven specs and integration scaffolding routinely
  // exceed both budgets without indicating production-code drift.
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      complexity: ['warn', 15],
      'max-lines-per-function': ['warn', { max: 80, skipBlankLines: true, skipComments: true, IIFEs: true }],
      'max-lines': ['warn', { max: 400, skipBlankLines: true, skipComments: true }],
    },
  },

  // ── maintainability hints (Sonar-style) ──────────────────────────────────────
  // Cheap, type-info-free rules that catch the kind of drift a reviewer would catch.
  // Typed rules (no-floating-promises, no-misused-promises, no-non-null-assertion) are
  // deferred until parserOptions.project is wired — they require typed linting.
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}'],
    rules: {
      eqeqeq: ['error', 'always'],
      'no-else-return': ['error', { allowElseIf: false }],
      'no-useless-return': 'error',
      'no-shadow': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports', disallowTypeAnnotations: true },
      ],
      '@typescript-eslint/array-type': ['error', { default: 'array-simple', readonly: 'array-simple' }],
    },
  },

  // ── no barrel exports anywhere under src/ ────────────────────────────────────
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': noBarrels,
    },
  },

  // ── fs.appendFile is fenced to integration/io/ ──────────────────────────────
  // The harness routes every append-stream write through the `AppendFile` port. A stray
  // `fs.appendFile` outside `integration/io/` silently bypasses the port's structured-error
  // guarantees.
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/integration/io/**'],
    rules: {
      'no-restricted-syntax': [noFsAppendFile[0], noFsAppendFile[1], noFsAppendFile[2], noBarrels[1]],
    },
  },

  // ── domain ───────────────────────────────────────────────────────────────────
  // Purest layer: entities, value objects, errors, Result, observability interfaces. Imports
  // nothing outside src/domain/ and may not pull in I/O-bearing node modules.
  {
    files: ['src/domain/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': domainLayerRule,
      'no-restricted-syntax': [noClassInDomainOrBusiness[0], noClassInDomainOrBusiness[1], noBarrels[1]],
    },
  },

  // ── integration/ai/prompts/<x>/ — sibling-prompt isolation ───────────────────
  // Each prompt is independent. Shared machinery lives under prompts/_engine/.
  ...PROMPTS.map(
    (active): Linter.Config => ({
      files: [`src/integration/ai/prompts/${active}/**/*.{ts,tsx}`],
      rules: {
        'no-restricted-imports': siblingIsolationRule(
          '**/integration/ai/prompts',
          active,
          PROMPTS,
          ['_engine', '_partials'],
          'prompt'
        ),
      },
    })
  ),

  // ── integration/ai/providers/<x>/ — sibling-provider isolation ───────────────
  // Each tool adapter is independent. Cross-tool sharing goes through providers/_engine/.
  ...PROVIDERS.map(
    (active): Linter.Config => ({
      files: [`src/integration/ai/providers/${active}/**/*.{ts,tsx}`],
      rules: {
        'no-restricted-imports': siblingIsolationRule(
          '**/integration/ai/providers',
          active,
          PROVIDERS,
          ['_engine'],
          'provider'
        ),
      },
    })
  ),

  // ── integration/ai/readiness/<x>/ — sibling-readiness-probe isolation ────────
  // Each per-tool readiness probe is independent. Cross-tool sharing goes through readiness/_engine/.
  ...READINESS_PROVIDERS.map(
    (active): Linter.Config => ({
      files: [`src/integration/ai/readiness/${active}/**/*.{ts,tsx}`],
      rules: {
        'no-restricted-imports': siblingIsolationRule(
          '**/integration/ai/readiness',
          active,
          READINESS_PROVIDERS,
          ['_engine'],
          'readiness probe'
        ),
      },
    })
  ),

  // ── integration/ai/skills/<x>/ — sibling-skill isolation ─────────────────────
  // Per-tool adapter directories (claude/codex/copilot) and skill-source directories
  // (bundled/project) are all independent siblings. Cross-sibling sharing goes through
  // skills/_engine/. The composition switch over the per-tool adapters lives at
  // skills/adapter-factory.ts (directly under skills/, outside the sibling glob).
  ...SKILLS.map(
    (active): Linter.Config => ({
      files: [`src/integration/ai/skills/${active}/**/*.{ts,tsx}`],
      rules: {
        'no-restricted-imports': siblingIsolationRule('**/integration/ai/skills', active, SKILLS, ['_engine'], 'skill'),
      },
    })
  ),

  // ── integration/ai/** — port declarations must live in _engine/ ──────────────
  // Port-shaped names (`*Port`, `*Adapter`, `*Provider`, `*Sink`, `*Loader`, `*Probe`,
  // `*Reader`, `*Writer`, `*Renderer`, `*Detector`) define cross-tool contracts. They
  // belong inside the concept's `_engine/` sub-namespace so concrete siblings depend on
  // a contract, not on a sibling adapter. Factory-input shapes named `*Deps` don't match
  // the pattern and are unaffected.
  {
    files: ['src/integration/ai/**/*.{ts,tsx}'],
    ignores: ['src/integration/ai/**/_engine/**', 'src/integration/ai/**/_partials/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        noBarrels[1],
        {
          selector:
            'TSInterfaceDeclaration[id.name=/(Port|Adapter|Provider|Sink|Loader|Probe|Reader|Writer|Renderer|Detector|Contract)$/]',
          message:
            'Port-shaped interfaces must live under integration/ai/<concept>/_engine/. Either move this declaration or rename it (e.g. `*Deps` for factory inputs).',
        },
        {
          selector:
            'TSTypeAliasDeclaration[id.name=/(Port|Adapter|Provider|Sink|Loader|Probe|Reader|Writer|Renderer|Detector|Contract)$/]',
          message:
            'Port-shaped type aliases must live under integration/ai/<concept>/_engine/. Either move this declaration or rename it.',
        },
      ],
    },
  },

  // ── business ─────────────────────────────────────────────────────────────────
  // Use cases + ports/repositories + business helpers (feedback parser, interactive prompt,
  // event bus, scm + version port shapes). May depend on domain + business only. No I/O-bearing
  // node modules. No imports from integration or application — integration concerns reach
  // business via function-shape deps that the composition root wires up. Entities live in
  // src/domain/entity/.
  {
    files: ['src/business/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': businessLayerRule,
      'no-restricted-syntax': [
        noClassInDomainOrBusiness[0],
        noClassInDomainOrBusiness[1],
        noBarrels[1],
        {
          selector: "TSTypeAliasDeclaration[id.name=/Output$/] > TSTypeReference[typeName.name='Result']",
          message:
            '*Output types must be the success-side data shape, not the Result envelope. Put `Result<FooOutput, ErrorUnion>` in the function signature instead.',
        },
      ],
    },
  },

  // ── src/business/<x>/ — sibling-business isolation ───────────────────────────
  // Each business sub-domain is independent. `observability/` is the universal
  // cross-cutting target — Logger and the event bus are infra-shaped ports every
  // sibling consumes — so it is on the allow-list. Future shared abstractions
  // should live under `_engine/` or `_shared/`.
  ...BUSINESS_SIBLINGS.map(
    (active): Linter.Config => ({
      files: [`src/business/${active}/**/*.{ts,tsx}`],
      rules: {
        'no-restricted-imports': siblingIsolationRule(
          '**/business',
          active,
          BUSINESS_SIBLINGS,
          ['_engine', '_shared', 'observability'],
          'business module'
        ),
      },
    })
  ),

  // ── src/domain/repository/<x>/ — sibling-repository isolation ────────────────
  // Each repository contract is per-aggregate. Shared abstractions live under `_base/`.
  ...REPOSITORY_SIBLINGS.map(
    (active): Linter.Config => ({
      files: [`src/domain/repository/${active}/**/*.{ts,tsx}`],
      rules: {
        'no-restricted-imports': siblingIsolationRule(
          '**/domain/repository',
          active,
          REPOSITORY_SIBLINGS,
          ['_base'],
          'repository module'
        ),
      },
    })
  ),

  // ── integration ──────────────────────────────────────────────────────────────
  // Concrete impls of business / ai ports + low-level I/O / shell wrappers. May depend on
  // domain + business + ai. The progress-file sink, for instance, implements
  // `Sink<HarnessSignal>` — it consumes a type from ai/signals/.
  {
    files: ['src/integration/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': restrictImports(['application']),
    },
  },

  // ── application ──────────────────────────────────────────────────────────────
  // Composition root + chain framework + flow compositions + UI runtime. May depend on
  // everything else. Only the Result re-export rule applies broadly.
  {
    files: ['src/application/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { paths: [resultLibBan], patterns: [] }],
    },
  },

  // ── application/flows/** — chain compositions ───────────────────────────────
  // Flows + _meta composers + _shared Element factories. May freely use domain, business,
  // integration (port-level), and the chain framework — but NOT concrete provider/probe/skill
  // adapters under integration/ai/. Bootstrap selects those.
  {
    files: ['src/application/flows/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': chainsLayerRule,
    },
  },

  // ── application/flows/<x>/ — sibling-flow isolation ──────────────────────────
  ...FLOWS.map(
    (active): Linter.Config => ({
      files: [`src/application/flows/${active}/**/*.{ts,tsx}`],
      rules: {
        'no-restricted-imports': siblingIsolationRule('**/application/flows', active, FLOWS, [], 'flow'),
      },
    })
  ),

  // ── application/flows/_meta/<x>/ — sibling-meta-flow isolation ──────────────
  ...META_FLOWS.map(
    (active): Linter.Config => ({
      files: [`src/application/flows/_meta/${active}/**/*.{ts,tsx}`],
      rules: {
        'no-restricted-imports': siblingIsolationRule(
          '**/application/flows/_meta',
          active,
          META_FLOWS,
          [],
          'meta-flow'
        ),
      },
    })
  ),

  // ── tests ────────────────────────────────────────────────────────────────────
  // Tests wire every layer together — only the typescript-result rule applies.
  {
    files: ['tests/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { paths: [resultLibBan], patterns: [] }],
      'no-restricted-syntax': 'off',
    },
  },
  // The Result re-export point is the only file allowed to import typescript-result directly.
  {
    files: ['src/domain/result.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  // Domain errors extend the domain Error class — class declarations are intentional here.
  {
    files: ['src/domain/value/error/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': noBarrels,
    },
  },
  // ── Reserved path: src/integration/ai/signals/ is gone (replaced by ai/contract/_engine/).
  // Block any future addition under that path so the deleted XML-tag parser pipeline can't be
  // resurrected by accident. To re-introduce the path, remove this entry deliberately.
  {
    files: ['src/integration/ai/signals/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Program',
          message:
            'src/integration/ai/signals/ is reserved — the audit-[09] contract pipeline lives at src/integration/ai/contract/. Add new signal kinds as Zod schemas under src/integration/ai/contract/_engine/signals/<kind>/schema.ts instead.',
        },
      ],
    },
  },
] satisfies Linter.Config[];
