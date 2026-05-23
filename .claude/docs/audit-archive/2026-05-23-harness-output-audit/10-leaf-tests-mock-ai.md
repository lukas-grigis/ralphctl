# 10 — Leaf tests with mock AI

**Status:** open
**Scope:** every leaf that spawns an AI session
**Related:
** [09 AI session contract](09-ai-session-contract.md), [11 prompt unit tests](11-prompt-template-unit-tests.md)

## Why

LLMs are non-deterministic. The harness must be deterministic. Tests cannot
trust what a real AI returns — they must drive the leaf with a **mock AI** that
produces controllable `signals.json` content per the contract in
[09](09-ai-session-contract.md).

## What "mock AI" means here

The AI is reached via a port — `HeadlessAiProvider` (and `InteractiveAiProvider`). Under
the [09](09-ai-session-contract.md) contract, the AI's only output per spawn is `signals.json`. The mock writes that
single file (or doesn't, or writes malformed content) into the spawn's output directory before returning. The leaf
doesn't know the difference between a mock and a real provider.

```ts
// test/helpers/mock-ai-provider.ts
type SpawnFixture =
  | { kind: 'ok'; signals: unknown } // serialised via JSON.stringify into signals.json
  | { kind: 'ok-missing' } // spawn succeeds, signals.json NOT written
  | { kind: 'ok-raw'; rawBody: string } // spawn succeeds, signals.json contains this exact body (for invalid-JSON tests)
  | { kind: 'spawn-error'; error: Error }
  | { kind: 'abort' };

export const mockHeadlessProvider = (
  fixtures: Map<AbsolutePath /* output dir */, SpawnFixture>
): HeadlessAiProvider => ({
  run: async (session) => {
    const fixture = fixtures.get(session.outputDir);
    if (fixture === undefined) throw new Error(`no fixture for ${session.outputDir}`);
    if (fixture.kind === 'spawn-error') return Result.error(fixture.error);
    if (fixture.kind === 'abort') throw new AbortError();
    if (fixture.kind === 'ok') {
      await writeFile(join(session.outputDir, 'signals.json'), JSON.stringify(fixture.signals));
    } else if (fixture.kind === 'ok-raw') {
      await writeFile(join(session.outputDir, 'signals.json'), fixture.rawBody);
    }
    // 'ok-missing' → no file written
    return Result.ok({
      /* spawn metadata: durationMs, sessionId, exitCode */
    });
  },
});
```

## Required test cases per leaf

Every AI-spawning leaf MUST cover these branches:

| #   | Branch                       | Fixture kind                                                                                                    | Expected                                                                                                   |
| --- | ---------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | **Happy path**               | `ok` with valid signals matching the leaf's schema                                                              | `Result.ok`; signals fan out to the bus; harness-rendered sidecars exist on disk with the expected content |
| 2   | **`signals.json` missing**   | `ok-missing`                                                                                                    | `Result.error(InvalidStateError)` with `signals-missing`, hint names the path                              |
| 3   | **Malformed JSON**           | `ok-raw` with invalid JSON text                                                                                 | `Result.error(InvalidStateError)` with `signals-invalid`, JSON parse error in hint                         |
| 4   | **Schema fails Zod**         | `ok` with wrong shape (missing discriminator, wrong field types)                                                | `Result.error(InvalidStateError)` with Zod issue path in hint (e.g. `signals[2].type: invalid_literal`)    |
| 5   | **Schema fails refine**      | `ok` with a valid shape that violates a `refine` (e.g. two `evaluation` signals when contract says exactly one) | Same error, hint references the refine constraint                                                          |
| 6   | **Optional sidecar absent**  | `ok` with valid signals but no signal of the optional sidecar's kind (e.g. no `commit-message`)                 | `Result.ok`; the sidecar file is NOT written; downstream code handles the absence                          |
| 7   | **Optional sidecar present** | `ok` with the relevant signal kind included                                                                     | `Result.ok`; the sidecar file IS written; content matches `extract(signal)` byte-for-byte                  |
| 8   | **Spawn error**              | `spawn-error`                                                                                                   | Leaf surfaces the spawn error; does not attempt validation; no sidecars touched                            |
| 9   | **Abort during spawn**       | `abort`                                                                                                         | Leaf propagates `AbortError` transparently (no swallow in guards)                                          |

Branches 6 and 7 must be exercised for **each sidecar** declared in the leaf's contract — if the leaf has three optional
sidecars, that's six cases (3 × {absent, present}).

## Determinism rules

- Mock AI **must not depend on real time**. Use a `Clock` test-double if the validator uses timestamps for retry
  budgets.
- Mock AI **writes synchronously** before returning the spawn result. The leaf's "spawn returned, now validate"
  sequencing is observable in test.
- Tests are colocated with the leaf: `src/application/flows/<flow>/leaves/__tests__/<leaf>.test.ts`.
- Each test case gets its own tmpdir.

## Anti-patterns to forbid

- ❌ Tests that hit a real provider CLI. Slow, non-deterministic, network-flaky, billable.
- ❌ Tests that mock `parseHarnessSignals` or any signal-stream parser. Those are deleted
  under [09](09-ai-session-contract.md). Mock at the port boundary only.
- ❌ Tests that share a tmpdir across cases.
- ❌ Tests that swallow Zod issues. The whole point of the contract is that schema failures surface — assert the Zod
  issue path.
- ❌ Tests that probe the bus directly to verify a signal was published. Instead: capture published signals via a fake
  `EventBus` subscriber wired into the test deps, then assert the captured array matches the fixture exactly.

## Enforcement: ESLint rule

Per the lint-over-scaffold preference, enforce the test grid via an ESLint rule that observes the tree.

**Where the rule lives:** `eslint-rules/require-leaf-contract-tests.ts` (new top-level directory). Registered in
`eslint.config.ts` via a plugin block:

```ts
// eslint.config.ts (sketch)
import requireLeafContractTests from './eslint-rules/require-leaf-contract-tests.ts';
export default [
  // ...existing flat config...
  {
    plugins: { ralphctl: { rules: { 'require-leaf-contract-tests': requireLeafContractTests } } },
    rules: { 'ralphctl/require-leaf-contract-tests': 'error' },
  },
];
```

The rule:

> For every `*.contract.ts` file under `src/application/flows/<flow>/leaves/`, there must exist a matching
> `__tests__/<leaf>.test.ts` covering the nine branches against every signal kind in the contract.

Missing test → lint error with the leaf's path. New leaf added without its test grid → caught before commit. The rule's
`Program:exit` handler does a synchronous `fs.existsSync` check against the expected test path.

## Action items

- [ ] Write `test/helpers/mock-ai-provider.ts` with the fixture-map shape above.
- [ ] Provide `test/helpers/signals-fixtures/<flow>/<leaf>/{happy,missing-evaluation,too-many-evals,…}.ts` so per-leaf
      test files stay small.
- [ ] Wire the helper into the existing `wire()` test bootstrap so tests build deps from a tmpdir + this mock.
- [ ] Backfill the nine cases for each existing AI-spawning leaf: `generator`, `evaluator`, refine's leaf, plan's leaf,
      ideate's leaf, readiness leaves.
- [ ] Add the ESLint rule under `eslint-rules/` (or wherever the project keeps custom rules) once the backfill lands.
