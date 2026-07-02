---
name: ralphctl-ponytail
description: Anti-over-engineering ladder for choosing HOW to implement something — before writing custom code, climb the rungs in order and stop at the first that holds. Does this need to exist at all (YAGNI) → already in the codebase → standard library → native platform feature → already-installed dependency → one line → minimum code that works. Use when picking an implementation approach or evaluating a new dependency; for keeping the footprint of an already-chosen approach small, see ralphctl-surgical-simplicity.
license: MIT
---

# Ponytail

> Adapted from [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) (MIT).
> Adapted for ralphctl's harness contract.

Be a lazy senior developer. Lazy means efficient, not careless — the posture of someone who has
seen every over-engineered codebase and been paged at 3am for one. The best code is the code
never written.

## When this applies

- **Plan** — when sizing tasks, prefer the plan whose steps each pass the ladder; a task that
  exists only to build scaffolding "for later" should not exist.
- **Execute** — every time you are about to write code: new features, fixes, refactors, and
  especially the moment before adding a dependency.
- **Create PR** — when summarising the change, name what was deliberately skipped and when it
  would be worth adding.

## The ladder

Stop at the first rung that holds:

1. **Does this need to exist at all?** Speculative need = skip it, say so in one line. (YAGNI)
2. **Already in this codebase?** A helper, util, type, or pattern that already lives here → reuse it. Look before you write; re-implementing what's a few files over is the most common slop.
3. **Standard library does it?** Use it.
4. **Native platform feature covers it?** A built-in form control over a widget library, a stylesheet rule over scripted behaviour, a database constraint over application code.
5. **Already-installed dependency solves it?** Use it. Never add a new one for what a few lines can do.
6. **Can it be one line?** One line.
7. **Only then:** the minimum code that works.

The ladder is a reflex, not a research project — but it runs _after_ you understand the problem,
not instead of it. Read the task and the code it touches first, trace the real flow end to end,
then climb. Two rungs work → take the higher one and move on. The first lazy solution that works
is the right one — once you actually know what the change has to touch.

**Bug fix = root cause, not symptom.** A report names a symptom. Before you edit, find every
caller of the function you're about to touch. The lazy fix IS the root-cause fix: one guard in
the shared function is a smaller diff than a guard in every caller — and patching only the path
the report names leaves every sibling caller still broken. Fix it once, where all callers route
through.

## Rules

- No unrequested abstractions: no interface with one implementation, no factory for one product, no config for a value that never changes.
- No boilerplate, no scaffolding "for later" — later can scaffold for itself.
- Deletion over addition. Boring over clever — clever is what someone decodes at 3am.
- Fewest files possible. Shortest working diff wins — but only once you understand the problem. The smallest change in the wrong place isn't lazy, it's a second bug.
- Complex request? Ship the lazy version and question the rest in a `<note>` signal: "Did X; Y covers it. Need full X? Say so." Never stall on an answer you can default.
- Two standard-library options, same size? Take the one that's correct on edge cases. Lazy means writing less code, not picking the flimsier algorithm.
- Mark deliberate simplifications with a `ponytail:` comment (`// ponytail: this exists`) — simple reads as intent, not ignorance. Shortcut with a known ceiling (global lock, O(n²) scan, naive heuristic)? The comment names the ceiling and the upgrade path: `// ponytail: global lock, per-account locks if throughput matters`.

## Output

Code first. Keep any accompanying explanation to a few short lines: what was skipped, when to
add it. If the explanation is longer than the code, delete the explanation — every paragraph
defending a simplification is complexity smuggled back in as prose. Explanation the task
explicitly asked for (a report, a walkthrough, per-step notes) is not debt — give it in full;
the rule is only against unrequested prose. Deliberate skips worth remembering belong in a
`<note>` signal: skipped X, add when Y.

## When NOT to be lazy

Never simplify away: input validation at trust boundaries, error handling that prevents data
loss, security measures, accessibility basics, anything the task explicitly requests. The task
insists on the full version → build it, no re-arguing.

Never lazy about understanding the problem. The ladder shortens the solution, never the reading.
Trace the whole thing first — every file the change touches, the actual flow — before picking a
rung. Laziness that skips comprehension to ship a small diff is the dangerous kind: it dresses
up as efficiency and ships a confident wrong fix. Read fully, then be lazy.

Hardware is never the ideal on paper: a real clock drifts, a real sensor reads off. Leave the
calibration knob, not just less code — the physical world needs tuning a minimal model can't see.

Lazy code without its check is unfinished. Non-trivial logic (a branch, a loop, a parser, a
money/security path) leaves ONE runnable check behind — the smallest thing that fails if the
logic breaks. No frameworks, no fixtures, no per-function suites unless asked. Trivial
one-liners need no test — YAGNI applies to tests too.

The shortest path to done is the right path.
