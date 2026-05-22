# 11 — Prompt template unit tests

**Status:** open
**Scope:** every prompt template under `src/integration/ai/prompts/<flow>/template.md` and `_partials/`
**Related:** [09 AI session contract](09-ai-session-contract.md), [10 leaf tests](10-leaf-tests-mock-ai.md)

## Why

Today: a prompt template can reference a `{{PLACEHOLDER}}` that the parameter
schema doesn't supply, or the parameter schema can declare a field that the
template never substitutes. The first crashes at runtime; the second is dead
code in the schema. Neither is caught at typecheck.

Each template ships a branded `Prompt` type + parameter schema (per CLAUDE.md).
The invariant we want is: **template placeholders and parameter-set fields are
exactly equal sets, both directions checked at test time.**

## The invariant

For every prompt template `T` with parameter schema `P` and (per [09](09-ai-session-contract.md)) an `AiOutputContract`
`C`:

1. **Every `{{X}}` in T is a field of P.** No referenced-but-undeclared placeholders.
2. **Every field of P appears at least once in T.** No declared-but-unused fields.
3. **Every partial referenced by T resolves to a file in `_partials/`.** No dangling includes.
4. **Every placeholder in every partial chained from T is satisfied by P** (recursive — partials can include partials).
5. **The rendered `{{OUTPUT_CONTRACT_SECTION}}` round-trips through `C.signalsSchema`.** Whatever example the prompt
   shows the AI must itself parse cleanly as valid `AiSignal[]`. Catches "I changed the schema but forgot to update the
   prompt example" drift.

These are all syntactic / structural checks. They don't validate that the AI understands the prompt, only that the
substitution and schema-example contracts hold.

## Test pattern

```ts
// src/integration/ai/prompts/implement/__tests__/template.test.ts
import { implementPromptDef } from '../def.ts';
import { extractPlaceholders, expandPartials } from '@src/integration/ai/prompts/_engine/test-utils.ts';

describe('implement prompt template', () => {
  it('every {{X}} in the expanded template is supplied by the parameter schema', () => {
    const expanded = expandPartials(implementPromptDef.template, implementPromptDef.partials);
    const placeholders = extractPlaceholders(expanded); // returns Set<string>
    const declared = new Set(Object.keys(implementPromptDef.paramSchema.shape));
    expect([...placeholders].sort()).toEqual([...declared].sort());
  });

  it('every partial referenced by the template exists in _partials/', () => {
    const refs = extractPartialRefs(implementPromptDef.template);
    for (const ref of refs) {
      expect(implementPromptDef.partials).toHaveProperty(ref);
    }
  });

  it('builds a valid prompt against a fully-populated parameter set', () => {
    const params = sampleParams();
    const prompt = buildPrompt(implementPromptDef, params);
    expect(prompt).not.toMatch(/\{\{[A-Z_]+\}\}/); // no leftover placeholders
  });

  it('the rendered output-contract example parses through the leaf contract schema', () => {
    const params = sampleParams();
    const prompt = buildPrompt(implementPromptDef, params);
    const example = extractContractExample(prompt); // pulls the JSON between explicit markers
    const parsed = generatorOutputContract.signalsSchema.safeParse(JSON.parse(example));
    expect(parsed.success).toBe(true);
  });
});
```

## What lives in `_engine/test-utils.ts`

Pure helpers (no I/O, no async) usable by every prompt test:

- `extractPlaceholders(template: string): Set<string>` — regex-walks `{{X}}` (case-insensitive — see open questions).
- `extractPartialRefs(template: string): Set<string>` — for whatever syntax partials use today (`{{> partial-name}}` or
  similar).
- `expandPartials(template: string, partials: Record<string, string>): string` — recursive partial expansion, throws on
  dangling ref.
- `sampleParams(schema: ZodSchema): Params` — generate a fully-populated fixture from a Zod schema (use existing fixture
  factories if they exist; otherwise hand-write a `sampleParams()` per template).

## Scope: which templates

Every template under `src/integration/ai/prompts/<flow>/` gets a `__tests__/template.test.ts`. Current set (confirm
against the tree):

- `prompts/implement/template.md` (generator)
- `prompts/evaluate/template.md`
- `prompts/refine/template.md`
- `prompts/plan/template.md`
- `prompts/ideate/template.md`
- `prompts/readiness/template.md` (if exists)

A future-flow doesn't need scaffold magic — see "Enforcement: ESLint rule" below.

## Open questions

- **Placeholder case-sensitivity.** Today the convention is SCREAMING*SNAKE_CASE inside `{{...}}`. Should the test
  enforce that, or just check the equality? \_Tentative: check equality only; convention is enforced by code review / a
  separate lint rule.*
- **Optional placeholders.** Some sections render to empty string when their data is absent (e.g.
  `{{PRIOR_CRITIQUE_SECTION}}` on turn 1). The CLAUDE.md prompt rules say "{{VARIABLE}} placeholders may be empty —
  avoid numbered lists that gap on empty substitution." That's a content rule, not a structural one. The test enforces
  presence in the parameter schema; whether the parameter renders empty is the renderer's problem.
- **Sample-params autogen vs hand-written.** Zod ships `safeParse` but no built-in mock. `@anatine/zod-mock` or similar
  could autogenerate, but introduces a dep. _Tentative: hand-write sample fixtures per template; they're small and
  double as documentation._

## Enforcement: ESLint rule, not scaffold modification

Instead of teaching `pnpm gen:flow <name>` to emit a test stub (which only fires on new-flow creation and gets stale
fast), enforce the invariant with an **ESLint rule** that runs on every lint pass.

**Where the rule lives:** `eslint-rules/require-prompt-template-tests.ts` (same top-level directory as the
leaf-contract-test rule in [10](10-leaf-tests-mock-ai.md)). Registered in `eslint.config.ts` via the same plugin block.

The rule:

> For every prompt definition (whatever the project's convention is — `def.ts`, `definition.ts`, or `template.md` under
> `src/integration/ai/prompts/<flow>/`), there must exist a colocated `__tests__/template.test.ts` whose body exercises
> the four invariants above (placeholder ↔ parameter parity, partial existence, full-substitution, contract-example
> round-trips through `signalsSchema`).

The rule's `Program:exit` handler globs the prompts tree (any convention), checks for the sibling test, and fails with a
clear message naming the missing file. Missing test → lint error. New flow added without its test → caught before
commit.

This pattern (lint, not scaffold) generalises: prefer ESLint rules that **observe the repo state** over scaffold tooling
that **mutates the repo state on demand**. Lint fires every time; scaffolds fire once.

## Action items

- [ ] Add `src/integration/ai/prompts/_engine/test-utils.ts` with the four helpers.
- [ ] One `__tests__/template.test.ts` per existing prompt directory.
- [ ] Add an ESLint rule under `eslint-rules/` (or wherever the project keeps custom rules) that enforces the colocated
      test per prompt directory + presence of the three required test cases.
- [ ] Add to CLAUDE.md's "Implementation Style" section: "Every prompt template has a `__tests__/template.test.ts`
      enforcing placeholder/parameter equality. The ESLint rule `prompts/require-template-tests` (or similar) catches
      missing tests."
