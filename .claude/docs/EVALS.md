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
the harness already re-runs its claim). One trial is one cold turn per role; the multi-turn gen-eval loop and
the `*-continuation` prompts are not measured. There are no model graders, no dollar cost and no caching.

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
`resolveEffortForRow`. That preset runs Sonnet (`claude-sonnet-5`) on every row: evaluate and select-candidate
use the evaluator row (`high`), implement the generator row (`high`), detect-scripts the readiness row
(`low`). Any preset name is accepted via `--preset`. `--provider/--model/--effort` replace their field on every
row. Model ids are validated by the provider adapter when it spawns, not up front — an id the catalog does not
know (there is no "Sonnet 5.5") fails every trial, and three ungraded trials in a row stop the run.

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
- Counts are the provider's reported input and output figures. For Claude those exclude cache-read and
  cache-creation tokens (separate fields in the stream's `usage`, which `ProviderUsage` does not carry), so
  `--max-tokens` bounds uncached input plus output — it is not a bill.
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

Shipped: 7 evaluate fixtures (off-by-one, missing function, test tampering, unhandled empty input, shell
injection, renamed export, empty working tree — each a clean/defect pair), 2 implement, 2 detect-scripts,
2 select-candidate. Not yet shipped: reviewer-labelled evaluate fixtures (`UNVERIFIED`, `[spec-ambiguity]`) and a
reconstructed real failure — they need named human reviewers and a real past failure to reconstruct. The
schema and graders already support both. Anthropic's guidance is that "20-50 simple tasks drawn from real
failures is a great start"; this set is smaller and synthetic, so treat early intervals as very wide.

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
