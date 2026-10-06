# Prompt / model evals

An opt-in harness that answers one question: _does this prompt edit, or this model swap, make a headless
flow better or worse — and is the difference bigger than the noise?_ It lives in `scripts/eval/` (dev
tooling, not product), runs with `pnpm eval`, and is never part of `pnpm test`, `verify`, CI or the build.
Only its own hermetic unit and integration tests (a scripted fake provider, no AI CLI, no tokens) run there.

## What it measures

Four headless flows, each through the **shipped** prompt builders, output contracts and session profiles, so a
trial measures what production sends:

| Flow               | One trial is                                              | Graded by (code only)                                                                   |
| ------------------ | --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `evaluate`         | one cold evaluator turn over `HEAD` + an uncommitted diff | verdict equals the fixture's expected status (secondary: dimensions, criteria, markers) |
| `implement`        | one cold generator turn on a buggy repo                   | hidden oracle exits 0 **and** no protected file changed                                 |
| `detect-scripts`   | one read-only repo inventory                              | the proposed `verify-script` exits 0 on a clean copy and non-zero on a broken copy      |
| `select-candidate` | the pairwise judge over two candidate summaries           | picked candidate equals the known winner — every item runs in **both** orders           |

Not covered: `plan`, `ideate`, `refine` (no headless path ships for them — they run through
`InteractiveAiProvider`), `check-plan` (deterministic, no model call, already unit-tested), and
`reproduce`, `review`, `readiness`, `detect-skills`, `create-pr` (next candidates; `reproduce` first, because
the harness already re-runs its claim), and `apply-feedback`, `distill-learnings`, `implement-crash-resume`. One trial is one cold turn per
role; the multi-turn gen-eval loop and
the `*-continuation` prompts are not measured. There are no model graders and no dollar cost; cache tokens are counted, not priced.

## Commands

```bash
pnpm eval check   [--flow a,b] [--tier T] [--fixture GLOB]        # 0 tokens: prove every fixture label
pnpm eval run     --max-tokens N [--flow a,b] [--tier regression|capability] [--fixture GLOB] [-k 3]
                  [--preset P] [--provider P --model M --effort E] [--reserve-tokens N]
                  [--max-wall-min M] [--allow-unmetered] [--keep-workspaces] [--dry-run]
pnpm eval compare --max-tokens N (--candidate-templates DIR | --candidate-model M
                  [--candidate-provider P] [--candidate-effort E]) …same flags as run
pnpm eval report  <baseline/results.json> <candidate/results.json>  # 0 tokens: offline paired analysis
```

Also accepted: `--fixtures-dir DIR` and `--results-dir DIR` (defaults `evals/fixtures`, `evals/results`).

**Baseline, then compare.**

```bash
pnpm eval check                                   # once, and after editing any fixture
pnpm eval run --max-tokens 400000                 # a baseline; note the token cost it prints
# the edit lives in a separate checkout; this checkout stays the baseline
git worktree add ../ralphctl-cand && $EDITOR ../ralphctl-cand/src/integration/ai/prompts/evaluate/template.md
pnpm eval compare --max-tokens 800000 --candidate-templates ../ralphctl-cand/src/integration/ai/prompts
```

`--candidate-templates DIR` swaps prompt text at the `TemplateLoader` port: the candidate arm reads
`<DIR>/<name>/template.md` and `<DIR>/_partials/<name>.md`. The baseline arm reads this checkout's
`src/integration/ai/prompts` — under `pnpm eval` (tsx) that is the working tree, **not** a frozen bundle, so
editing the prompts in place and passing that same directory compares a prompt with itself. `compare` refuses
that (exit 1, before any spend) when both arms' template hashes are equal. Only template **text** can change
this way. A change to a prompt _definition_ (its TypeScript parameters or builder) needs two checkouts: run
`pnpm eval run` in each, then `pnpm eval report a/results.json b/results.json`.

`--candidate-model M` runs the same fixtures with the model (and optionally provider / effort) replaced on
every row of the candidate arm.

**Default arm.** `applyPreset('claude-economic', DEFAULT_SETTINGS)`, effort resolved per role through
`resolveEffortForRow`. That preset runs Sonnet 5.5 (`claude-sonnet-5-5`) on every row: evaluate and
select-candidate use the evaluator row (`high`), implement the generator row (`high`), detect-scripts the
readiness row (`low`). Any preset name is accepted via `--preset`. `--provider/--model/--effort` replace their
field on every row — `--candidate-model claude-sonnet-5` compares against the previous Sonnet. Model ids are
validated by the provider adapter when it spawns, not up front — an id the catalog does not know (a typo, or
a dotted Copilot-style `claude-sonnet-5.5` on the claude-code provider) fails every trial, and three ungraded
trials in a row stop the run.

**Exit codes.** `0` completed; `2` stopped early (budget, wall, unmetered, repeated errors) with partial
results written; `130` aborted; `1` any other failure, including a fixture whose label is not proven.

## The budget flag

`--max-tokens N` is **required** — there is no measured per-trial cost to size a default from, so the harness
fails closed. Usage arrives only after a spawn finishes, so the budget cannot stop a trial mid-spawn; it is
enforced by **admission**: a trial starts only if `spent + reserve <= N`, where the reserve is the largest
token total seen so far for that flow (`--reserve-tokens` before the first observation, default 0). Trials run
serially. Corrective nudges (resumed respawns after an invalid `signals.json`) count against the budget.
Nudges apply only where production nudges: `evaluate` and `implement`. `detect-scripts` and `select-candidate`
validate once — production falls back or errors on an invalid file there — so an invalid file is a failed
trial with `nudgeCount` 0 and no respawn.

- A trial whose provider reports no token counts stops the run (`unmetered`) unless `--allow-unmetered` is set.
  Missing counts are never imputed; they print as `n/a`.
- `usage` reports one spawn's tokens. The rate-limit retry loop returns the **successful** attempt's usage, so
  tokens spent on rate-limited attempts are not in the total — treat totals as a lower bound.
- Counts are the provider's reported figures, kept apart: in, cache read, cache write, out.
  `--max-tokens` bounds their **sum** (`ProviderUsage.cacheReadInputTokens` / `cacheCreationInputTokens`
  carry the cache counts). Engineering judgment: Claude reports cache reads and writes beside `input_tokens`,
  not inside it, and on a cached agent turn they dwarf it — counting input + output alone under-counted by
  orders of magnitude. "in" is the adapter's `inputTokens`, not guaranteed to exclude cache: only Claude is known to report it apart from the cache counts (`parse-stream.ts`). The recorded Codex fixture (`codex-provider.test.ts:832`) has `cached_input_tokens` 25344 inside `input_tokens` 27669 and `codex/headless.ts` passes the full `input_tokens`, so on `--provider codex` "in" includes cached tokens and cache read stays `n/a`. Only Claude and Grok populate the cache fields; Codex (`cached_input_tokens`) and
  OpenCode (`tokens.cache`) report them but their relation to `input` is unverified, so they stay unset
  rather than risk double counting. A total is a token volume, not a bill: cache tokens are priced
  differently from plain input and no rate is applied. Results files written before this change show cache
  columns as `n/a`.
- `--max-wall-min M` adds a wall-clock cap. On any stop the results are written with `stoppedReason` and the
  unreached items are listed as incomplete; they are left out of the statistics and out of pairing.
- Ctrl-C aborts the in-flight spawn (the provider's kill ladder), writes the partial results, and exits 130.

`--dry-run` swaps the provider for a scripted fake that answers as a perfect model. It exercises the whole
pipeline (fixture proof, workspaces, prompts, validation, grading, results) for 0 tokens, and the summary is
bannered so its numbers are never read as a measurement.

## Fixtures

```
evals/fixtures/<flow>/<id>/
  fixture.json          validated by scripts/eval/fixture-schema.ts
  repo/                 base tree, committed as HEAD in each trial workspace
  variants/*.patch      evaluate: clean.patch (reference) + defect.patch; implement: reference.patch;
                        detect-scripts: broken.patch — applied UNCOMMITTED
  candidates/           select-candidate: a|b.json (composeCandidateSummary input) + a|b.patch
  oracle/               hidden checks — never copied into a workspace before grading
```

A fixture is plain Node ESM tested with `node --test`: Node is guaranteed by `engines`, needs no install, and
keeps fixtures generic. Fixture code is bad on purpose, so `evals/fixtures/` is excluded from ESLint, Prettier
and knip. `evals/results/` is gitignored.

**Authoring rules.**

- **One seeded defect per fixture, always paired with a clean variant** (clean = the reference solution, defect
  = the reference plus exactly one defect). Balanced pairs keep the set from optimising one direction.
- **The label is proven, not asserted.** `pnpm eval check` copies `oracle/` into a materialized variant and runs
  `oracle.command`: a clean / winning / reference variant must exit 0, a defect / losing / unmodified one must
  exit non-zero, else the fixture is rejected (a defect no hidden check can observe may be an equivalent mutant).
  `run` and `compare` call `check` first as a preflight.
- **Tamper-proofing.** `oracle.protectedPaths` are restored from the pristine `repo/` before the oracle runs, so
  a weakened visible test still fails; `implement` also counts any change to a protected path as a bypass. List
  specific existing test files, not a whole `test/` directory — a model adding a new test is not tampering.
- **`oracle: { "kind": "none", "reviewedBy": [a, b] }`** is only for verdicts a command cannot prove
  (`UNVERIFIED:` evidence, `[spec-ambiguity]`), and needs two distinct named reviewers.
- **`tier`**: `regression` items should sit near 100%; `capability` items should start low and are the ones that
  can show improvement. The shipped tier assignments are initial guesses — revise them after the first
  baseline. Capability items that reach 100% are listed as saturation candidates; retire them by hand.
- **`cluster`** names the repo family. Items from one family are correlated, so it drives the clustered
  standard error. `origin: real` items (a reconstructed past failure, made generic) are reported separately.
- The `task` is validated with the planner's own `TaskImportSpecSchema` (minus `projectPath`).

Shipped: 18 evaluate fixtures (each a clean/defect pair), 5 implement, 2 detect-scripts, 2 select-candidate.
`ev-01`..`ev-07` are the first, easy set; `ev-08`..`ev-18` and `im-03`..`im-05` are `tier: capability`, added
because the first real baseline put evaluate catch rate at 100% on 7 items — and "An eval at 100% tracks
regressions but provides no signal for improvement" (Anthropic, _Demystifying evals for AI agents_). Not yet
shipped: reviewer-labelled evaluate fixtures (`UNVERIFIED`, `[spec-ambiguity]`) and a reconstructed real
failure — they need named human reviewers and a real past failure to reconstruct. The schema and graders
already support both. Anthropic's guidance is that "20-50 simple tasks drawn from real failures is a great
start"; this set is smaller and synthetic, so treat early intervals as very wide.

### Harder fixtures: failure mode to fixture

Grounding. The evaluator is already told what to resist: `_partials/evaluator-failure-modes.md` names
"Superficial testing", "Crediting incomplete work" and "Rubber-stamping when the verify script passes", and
`_partials/evaluator-grading-rules.md` adds a verification-tampering audit and "A FAIL needs a concrete
observation". The new defects are built to sit where those rules are hardest to apply — a green suite, a
plausible diff, and the wrong behaviour on a path the visible tests never run. Zheng et al., _Judging
LLM-as-a-judge_ (arXiv 2306.05685), report "position, verbosity, and self-enhancement biases, as well as
limited reasoning ability" in LLM judges; that motivates padding defects inside larger, confident-looking
diffs (`ev-09`) and a clean diff that looks alarming (`ev-16`). Mutation testing supplies the labelling
discipline: a test "detects, and therefore rejects, a mutant upon test failure", and a mutant no test can
kill is an "equivalent mutant" (Wikipedia, _Mutation testing_) — which is why `pnpm eval check` requires the
hidden oracle to fail on every defect and pass on every clean variant. Anthropic: "Test both the cases where
a behavior _should_ occur and where it _shouldn't_" — hence the clean twin of every defect, plus `ev-16`
aimed at false-FAIL. The quotes are as returned by fetching those pages on 2026-09-30; the mapping of each
failure mode to a fixture below is engineering judgment.

Each defect's visible suite (`node --test test/*.test.mjs`) is green, so only reading the code or running an
input the suite skips reveals it. Which defects an `auto` criterion command would expose is deliberate: `C2`
covers the happy path, and the failing behaviour is either a `manual` criterion or only in the task
description.

| Fixture                                  | Failure mode (judgment)                                                                                    | Why the visible checks stay green                                         |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `ev-08-vacuous-test`                     | test asserts truthiness only; hour multiplier is 360, not 3600                                             | `assert.ok(x > 0)`; `C2` runs the seconds unit                            |
| `ev-09-weakened-assertion-large-diff`    | one existing expectation (53 to 52) edited inside a diff that mostly adds tests                            | the edited test agrees with the new `Math.floor`                          |
| `ev-10-boundary-page-zero`               | off-by-one on the rejection branch (`page < 0`), page 0 accepted                                           | only the happy paths and `-1` are tested                                  |
| `ev-11-default-changes-caller`           | new option defaults to on; an untouched caller (`scheduler.mjs`) turns random                              | new tests pass `jitter: false` explicitly; caller untested                |
| `ev-12-option-accepted-not-implemented`  | criterion claimed in a comment and signature, never applied (`maxLength`)                                  | test only checks the option is accepted                                   |
| `ev-13-swallowed-parse-error`            | one catch-all returns defaults; corrupt JSON silently ignored                                              | only the missing-file and valid-file cases are tested                     |
| `ev-14-lock-leak-on-error`               | release skipped when `fn` rejects (no `finally`)                                                           | the rejection test never inspects the lock                                |
| `ev-15-completion-order-results`         | results pushed in completion order instead of input order                                                  | test callbacks finish in start order                                      |
| `ev-16-spec-change-edits-tests`          | false-FAIL probe: both variants edit existing tests by spec; only MB/GB stay binary                        | defect drops the MB test; clean edits it and looks alike                  |
| `ev-17-input-mutated`                    | `items.sort` mutates and aliases the caller's array                                                        | tests read the output only                                                |
| `ev-18-unrequested-hardening`            | false-FAIL probe: clean `chunk` skips unrequested size validation; defect `<=` adds a trailing empty group | clean meets every criterion; defect's visible tests avoid exact multiples |
| `im-03-csv-line` (implement)             | quoting rules: embedded commas, doubled quotes, empty and trailing fields                                  | hidden oracle covers what a naive `split(',')` misses                     |
| `im-04-option-keeps-default` (implement) | a new option must leave the default output of `report.mjs` unchanged                                       | protected `test/report.test.mjs`, `test/format-bytes.test.mjs`            |
| `im-05-map-limit` (implement)            | concurrency cap, input order, and no new starts after the first rejection                                  | hidden oracle measures peak in-flight and start log                       |

Notes. `ev-09` and `ev-16` deliberately both edit existing tests; `ev-09` protects `test/cart.test.mjs`
(oracle restores it), `ev-16` cannot, because the spec changes those values. `ev-11` and `ev-16` carry a
`manual` criterion that names the hidden behaviour; `ev-08`, `ev-09`, `ev-14` and `ev-15` do not, so they
depend on the evaluator noticing. `ev-15` and `im-05` use millisecond timers (5-30 ms gaps); the ordering is
deterministic but a heavily loaded machine could in principle reorder timers, so read a lone `im-05` failure
in `oracle.txt` before trusting it. Expected `failedDimensions` are a judgment call and only feed the
secondary dimension-hit metric. Whether these actually lower the catch rate is unmeasured — no model has run
on them yet; run `pnpm eval run --flow evaluate --tier capability` for the first read.

## Reading `summary.md`

Every run writes `evals/results/<runId>/`: `trials.ndjson` (appended per finished trial, so a crash keeps them),
`results.json`, `summary.md` (both written atomically) and `trials/<fixture>/<variant>/<arm>/<n>/` holding
`prompt.md`, `signals.json`, `body.txt`, `grade.json` and `oracle.txt`. `results.json` records the git SHA and
dirty flag, `k`, the fixture-set hash and each arm's per-flow rows and template hash, so two runs are
comparable and reproducible.

- **Unit of analysis.** An _item_ is a (fixture, variant) — for select-candidate, one fixture across both
  orders. A _trial_ is one of its `k` repeats (default 3; select-candidate runs `2 × k`). The item score is the
  mean of its trials' `correct`; every interval is computed over item scores, never over pooled trials.
- **Metrics.** Per flow and arm: `correct` (the primary binary), first-try and after-nudges structural validity,
  `pass@k` (share of items with at least one correct trial), `pass^k` (share with all correct), flip rate (share
  whose trials disagree), tokens and wall time. evaluate adds catch rate (defect items), false-PASS and
  false-FAIL rate, dimension hit and `UNVERIFIED:` compliance; catch rate is also split by `origin`. implement
  adds false completion (claimed done, oracle failed). select-candidate adds order agreement.
- **Confidence intervals.** `mean ± 1.96 × SE`, with the SE clustered by `cluster`. `(approx)` marks fewer than
  30 items or a mean of exactly 0 or 1. At 0 or 100% the SE is 0, so the summary prints "all n at 100% — CLT CI
  degenerate" instead of a zero-width interval. Read a degenerate line as "no signal at this n", not "certain".
- **Is k big enough.** The line prints `mean(σ²_i)/K` beside `Var(s)`. Once the first is much smaller than the
  second, more repeats barely tighten the SE; add fixtures instead.
- **Comparison.** Items complete in both arms are paired: `d_i = s_B,i − s_A,i`. A difference is
  "detectable" only when its 95% CI excludes 0; otherwise the table says "no detectable difference at this N".
  MDE is the smallest effect this n could detect at α = .05 and power .8 — if the MDE is larger than any
  change you would care about, the run cannot tell you anything, whatever the verdict says. Arms are
  interleaved per trial and the arm that goes first alternates per item.
- **Trials to read.** Every incorrect trial links its artifact directory. Read them before trusting a number: a
  fixture or grader bug looks exactly like a model bug until you read the transcript.

## Statistics and sources

The estimators follow Miller, "Adding Error Bars to Evals" (arXiv 2411.00640): item score = mean of `K`
answers (§3.1); SE over items (Eq. 1); 95% CI (Eq. 3); clustered SE (Eq. 4); paired SE (Eq. 7); minimum
detectable effect from the sample-size formula (Eq. 9, rearranged for δ). The paired-and-clustered case applies
Eq. 4 to the item differences; Miller's own form for it is Eq. 8, which differs only by the small-sample
`n/(n-1)` factor on the diagonal terms. The estimate of ω² in the MDE is derived from this run's own data
(variance of the item differences minus the resampling terms, floored at 0).

The remaining choices are engineering judgment, not sourced: `k = 3`, α = .05 / β = .2, the `< 30 items`
approximation flag, the CI-excludes-0 verdict rule, serial trials with admission-based budgeting, and stopping
after three consecutive infrastructure errors. No small-sample interval (Wilson, exact) is implemented because
none was consulted. The design principles (isolated trials, a reference solution per task, balanced sets,
grade the outcome, bypass-resistant graders, `pass@k` / `pass^k`, read the transcripts) come from Anthropic,
"Demystifying evals for AI agents". See `RESEARCH-REFERENCES.md`.

## Where things live

`scripts/eval/` — `main.ts` (composition root), `cli.ts` (argv), `run.ts` (budgeted run loop), `run-trial.ts`
(one isolated trial), `flows/*.ts` (per-flow adapters), `grade.ts` / `stats.ts` / `metrics.ts` / `budget.ts`
(pure), `report.ts`, `results-store.ts`, `oracle.ts` (label proof), `workspace.ts`, `fake-provider.ts`.
Tests: `tests/unit/scripts/eval/`, `tests/integration/scripts/eval/`.
