---
name: ralphctl-performance-optimization
description: Measure-first performance discipline — take a baseline with the project's own tooling, find the actual bottleneck, change one thing, re-measure the same way, and keep the change only when it beats run-to-run noise with the tests still green. Use when a task states a performance target, reports slowness or a regression, or touches a hot path, query, cache, or connection pool; not for speculative optimisation without evidence of a problem.
license: MIT
---

# Performance Optimization

> Adapted from [addyosmani/agent-skills — "Performance Optimization"](https://github.com/addyosmani/agent-skills)
> (MIT). Adapted for ralphctl's harness contract.

Performance work without measurement is guessing, and guessing adds complexity that costs more than the
speed it buys. Measure, find the real bottleneck, fix that one thing, measure again — and keep only what
the numbers justify.

**When not to use:** there is no evidence of a problem. Optimising on a hunch is how neutral complexity
lands.

## When this applies

- **Execute** — when the task carries a performance target or a slowness report, or the change touches a
  hot path. The generator measures with the project's tooling; when reviewing, a performance claim with no
  before-and-after numbers behind it is a finding, and so is an "optimisation" that changed behaviour.

## The workflow

```
MEASURE → IDENTIFY → FIX ONE THING → RE-MEASURE (keep or undo) → GUARD
```

### 1. Measure

Use what the repository already has — a benchmark target, a profiler, a timing harness, a query-plan
command, a load script — found in its manifest, scripts, or CI configuration. Fix the budget before you
start: the same command, the same input, the same conditions (warm or cold cache, sample count). Record
the baseline numbers.

### 2. Identify

Let the symptom pick what to measure first:

- **Startup or first load is slow** — payload or bundle size, blocking work at start, slow first
  response.
- **Interaction feels sluggish** — long synchronous work on the main thread or event loop, redundant
  re-rendering or recomputation.
- **One operation is slow** — profile it; read the query plan of each query it runs.
- **Everything slows at once** — connection or thread pool exhaustion, memory pressure, CPU saturation.
- **Slowness is intermittent** — lock contention, garbage-collection pauses, a slow external dependency.
- **Memory keeps growing** — leaked references, unbounded caches or lists, retained payloads.

### 3. Fix one thing

Fix only the bottleneck step 2 identified. The usual suspects:

- **Query per row (N+1).** Fetch the relation in the same query or one batched query, not in the loop.
- **Unbounded fetching.** Every list read has a limit and a stable order.
- **A query that ignores its index.** "Add an index" is the guess; the query plan before and after is the
  measurement. A stale row estimate wants refreshed statistics, not a new index. Index for the query's
  shape — equality columns first, then the range or sort column. An index that did not change the plan
  is an undo, and every index taxes every write.
- **Pool exhaustion.** Every operation slows together and time goes to waiting for a connection. A bigger
  pool only moves the queue somewhere harder to see — find what holds connections, and size pools so the
  total across all processes stays under the server's limit.
- **Missing or wrong caching.** Cache only what is expensive to produce and read far more often than it
  changes. Every input that changes the result belongs in the key (tenant, locale, permissions, flags) —
  a key that omits the viewer serves one user's data to another. Pick one invalidation strategy and state
  the acceptable staleness. Protect hot keys against a stampede (serve stale while one request
  recomputes, or coalesce concurrent misses). Never cache what must be fresh.
- **Repeated work in a hot loop.** Hoist the invariant; memoise only what the profile shows is costly.

### 4. Re-measure: keep or undo

A fix is a hypothesis until re-measured — the same way as the baseline. Change one thing at a time so the
number is attributable, and repeat the measurement to compare the delta against run-to-run variance.

| Result against the baseline   | Action                                   |
| ----------------------------- | ---------------------------------------- |
| Beyond the noise, tests green | Keep it.                                 |
| Within the noise              | Undo it. Neutral is not a keep.          |
| Worse                         | Undo it.                                 |
| Faster, but a test went red   | Undo it — a regression dressed as a win. |

Correctness gates the metric: an "optimisation" that wins by skipping work the product needed (a
validation, a fresh read, an awaited step) is a regression.

**Record every attempt, kept and undone alike.** An undone attempt leaves no trace in the diff, which is
how the same dead idea gets tried again. Record idea, baseline and result, verdict, and why in a `note`
signal when the prompt's output-contract section lists it; otherwise fold it into the required signal's
own fields.

### 5. Guard

Protect the metric that justified the work. When the project already has a benchmark, performance test,
or budget, extend it to cover this path. Do not invent a new gate or pipeline step the task did not ask
for — name the missing guard in the same signal guidance as above instead.

## Common rationalisations

| Rationalisation                            | Reality                                                                             |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| "This optimisation is obvious"             | If you did not measure, you do not know. Re-measuring an obvious win is cheap.      |
| "The query is slow, add an index"          | Read the plan first. The index may exist and be unusable; every index taxes writes. |
| "Just cache it"                            | Caching a cheap call buys a staleness bug and nothing else.                         |
| "Raise the pool size"                      | It relocates the queue. Find what holds the connections.                            |
| "It didn't help much, but it doesn't hurt" | Neutral changes are maintained forever and bought nothing. Undo them.               |
| "We already wrote it, may as well keep it" | Sunk cost. The measurement does not care how long the change took.                  |

## Red flags

- An optimisation with no profiling data or baseline behind it.
- Several optimisations measured as one number.
- An index added without a query plan before and after.
- A cache key that omits an input the result depends on, or a cache with no stated staleness.
- A pool size raised in response to exhaustion without finding the holder.
- A "win" that needed a test changed, skipped, or deleted.

## Self-check

- [ ] Before-and-after numbers exist, taken the same way.
- [ ] The improvement exceeds run-to-run variance.
- [ ] Changes that did not beat the baseline were undone.
- [ ] Every attempt is recorded, including the undone ones.
- [ ] The existing tests still pass — behaviour did not change.
