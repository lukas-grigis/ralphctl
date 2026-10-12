---
name: ralphctl-ponytail
description: Anti-over-engineering ladder for choosing HOW to implement something — the smallest change that fully solves the task. Before writing custom code, climb the rungs in order and stop at the first that holds. Does this need to exist at all (YAGNI) → already in the codebase → standard library or platform feature → already-installed dependency → one line → minimum code that works. Use when picking an implementation approach or evaluating a new dependency; for keeping the footprint of an already-chosen approach small, defer to the ralphctl-surgical-simplicity skill when installed.
license: MIT
---

# Ponytail

> Adapted from [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) (MIT).
> Adapted for ralphctl's harness contract.

Be a lazy senior developer. Lazy means efficient, not careless — the posture of someone who has
seen every over-engineered codebase and been paged at 3am for one. The best code is the code
never written: solve the whole problem with the least new code.

## When this applies

- **Plan** — when sizing tasks, prefer the plan whose steps each pass the ladder; a task that
  exists only to build scaffolding "for later" should not exist.
- **Execute** — every time you are about to write code: new features, fixes, refactors, and
  especially the moment before adding a dependency.
- **Create PR** — when summarising the change, name what was deliberately skipped and when it
  would be worth adding.

## Before you write

Read the task and the code it touches. List every place your change must reach: callers, tests,
fixtures, config, exports. Check what your change could break for users: data it would destroy or
expose, callers that stop working. That is scope. Extra features are not.

## The ladder

Stop at the first rung that fully works:

1. **Does this need to exist at all?** Skip features, options, and flexibility nobody asked for, and say so in one line. (YAGNI) A vague request gets the smallest version that does the core job.
2. **Already in this codebase?** A helper, util, type, component, or pattern that already lives here → reuse it, the way the surrounding code does. Look before you write; re-implementing what's a few files over is the most common slop.
3. **Standard library or a native platform feature covers it?** Use it — a built-in form control over a widget library, a stylesheet rule over scripted behaviour, a database constraint over application code — unless the project has its own: a house component beats a native widget.
4. **Already-installed dependency solves it?** Use it. Never add a new one for what a few lines can do.
5. **Can it be one line a reader gets at a glance?** One line.
6. **Only then:** the minimum code that works.

The ladder is a reflex, not a research project — but it runs _after_ you understand the problem,
not instead of it. Trace the real flow end to end, then climb. Two rungs work → take the higher
one and move on. The first lazy solution that works is the right one — once you actually know
what the change has to touch.

**Bug fix = root cause, not symptom.** A report names a symptom. Before you edit, find every
caller of the function you're about to touch. The lazy fix IS the root-cause fix: one guard in
the shared function is a smaller diff than a guard in every caller — and patching only the path
the report names leaves every sibling caller still broken. Fix it once, where all callers route
through.

## Rules

- Be lazy about the solution, never about the change itself: finish every part the task needs, including the callers, tests, and fixtures your change breaks.
- No unrequested abstractions: no interface with one implementation, no factory for one product, no wrapper or type conversion nobody asked for, no config for a value that never changes. Keep values in the form the platform already gives you.
- No boilerplate, no scaffolding "for later" — later can scaffold for itself.
- Keep the structure the codebase already has: its layers, interfaces, and conventions.
- Deletion over addition. Boring over clever — clever is what someone decodes at 3am.
- Fewest files possible. Shortest working diff wins — but only once you know everything it must touch. The smallest change in the wrong place isn't lazy, it's a second bug. A one-liner that needs decoding is not short.
- Code you move or merge keeps its error handling and validation.
- Comment only the why the code cannot show, in one line.
- Complex request? Ship the lazy version and question the rest: "Did X; Y covers it. Need full X? Say
  so." Write it as a `note` signal in `signals.json` when the prompt's output-contract section lists it,
  otherwise fold the question into the required signal's own fields. Never stall on an answer you can
  default.
- Two options of the same size? Take the one that's correct on edge cases. Lazy means writing less code, not picking the flimsier algorithm.
- A shortcut with a known limit (global lock, O(n²) scan, naive heuristic) gets a code comment naming the limit and the upgrade path, in this form: `// shortcut: global lock, per-account locks if throughput matters`.

## Output

Code first. Keep any accompanying explanation to one or two short lines: what you skipped or did
not check, and any risk a reviewer must know. If the explanation is longer than the code, delete
the explanation — every paragraph defending a simplification is complexity smuggled back in as
prose. Explanation the task explicitly asked for (a report, a walkthrough, per-step notes) is not
debt — give it in full; the rule is only against unrequested prose. Deliberate skips and unchecked
risks worth remembering: skipped X, add when Y — as a `note` signal in `signals.json` when the
prompt's output-contract section lists it, otherwise inside the required signal's own fields.

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

Lazy code without its check is unfinished. New non-trivial logic (a branch, a loop, a parser, a
money/security path, or a whole new script or app) leaves ONE runnable check behind — one small
test or an assert-based self-check, the smallest thing that fails if the logic breaks. No
frameworks, no fixtures, no per-function suites unless asked. Trivial one-liners need no test —
YAGNI applies to tests too.

The shortest path to done is the right path.
