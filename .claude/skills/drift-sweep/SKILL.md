---
name: drift-sweep
description: Audit the ralphctl `.claude/` setup (the 7 subagents, the in-repo skills, the `.claude/docs/` modules) and `CLAUDE.md` for DRIFT against the real `src/` — stale version stamps, renamed/dead paths, removed symbols, unshipped env vars, and fabricated references. Use this whenever someone asks to "audit / refresh / clean up / check the .claude setup", before cutting a release, after a large rename or refactor under `src/`, or when an agent or doc cites a path/symbol that "feels off". This is doc/config drift — it complements `verify` (which runs typecheck/lint/test for code correctness); reach for drift-sweep when the question is "do our agent and doc files still describe the code as it actually is?".
when_to_use: Trigger on "audit the .claude setup", "refresh the agents/docs", "is the .claude folder still accurate", "check for stale references", "pre-release doc check", or after any rename/move under src/ that the agent and doc files mirror. Not for runtime code correctness (use `verify`) and not for prose quality.
allowed-tools: Bash, Read, Grep, Glob, Edit
---

# Drift Sweep

The `.claude/` agent and doc files mirror the shape of `src/` — module paths, symbol names, env vars,
command names, version numbers. The code moves every day; these mirrors do not move with it unless someone
makes them. The result is silent drift: an agent confidently points the next session at `runtime/mount.tsx`
(deleted), a doc cites `RALPHCTL_JSON` (never shipped), every agent hardcodes `v0.7.0` while the repo is at
`0.12.x`. None of it fails a test, so nothing catches it — until a session follows a dead pointer and wastes
a turn, or a contributor trusts a stale acceptance criterion.

This skill is the cheap, repeatable counter-pressure: a mechanical sweep that surfaces _candidates_, followed
by judgement to confirm them. It is deliberately conservative — a false "this is drift" wastes a fix; a missed
one rots quietly. So the script flags, and you verify.

## When this earns its keep

- Someone asks to audit, refresh, or clean up `.claude/` or `CLAUDE.md`.
- Before a release — stale version stamps and dead paths shipping in docs is avoidable.
- Right after a rename/move under `src/` (a sibling renamed, a file relocated, a symbol dropped) — the agent
  and doc files that named the old shape are now wrong.

## How to run it

1. **Run the sweep harness** to get the candidate list:

   ```bash
   bash .claude/skills/drift-sweep/scripts/sweep.sh
   ```

   It scans `CLAUDE.md`, `.claude/agents/`, `.claude/docs/`, and `.claude/skills/` (markdown only) and prints
   candidates grouped into five buckets:
   - **[1] Version stamps** — every `vX.Y.Z` vs `package.json`. Noise is expected here: external tool versions
     (Claude Code, Copilot CLI) and historical migration notes (`v0.6.x → …`) are _legitimately_ pinned. A bare
     current-feature stamp like `v0.7.0` in a "this is how it works today" sentence is the real target.
   - **[2] Missing paths** — referenced `src/`, `tests/`, `scripts/` files/dirs that no longer exist. Highest
     signal; a gone path is almost always real drift.
   - **[3] Unread env vars** — `RALPHCTL_*` named in docs with zero non-test reads in `src/` (unshipped or removed).
   - **[4] Known stale patterns** — recurring renames (`tests/integration/flows/` → `…/application/flows/`,
     the `signals/` → `contract/` sibling rename, `mount.tsx`, `InkPromptAdapter`, `PromptPort`).
   - **[5] Symbol sample** — backticked identifiers to spot-check; too noisy to auto-resolve, so pick the
     load-bearing ones and grep them yourself.

2. **Verify every candidate against the real code before reporting it.** This is the non-negotiable step. The
   script cannot tell a real rename from a legitimate-but-similar name. Concretely:
   - For a flagged path: does it exist? what replaced it? (`ls`, `git log --follow`, `Grep` the new name).
   - For a flagged symbol: `grep -rl "<symbol>" src` — zero hits means fabricated/renamed; find the real one.
   - For a version stamp: is it describing _current behaviour_ (drift) or _history_ (`v0.6.x → v0.7.0`, keep)?
   - For an env var: `grep -rl "<VAR>" src | grep -v test` — confirm it is genuinely unread before flagging.

   A candidate that survives this check is real drift. One that does not (e.g. `signals.json` is a live
   runtime filename even though the `signals/` directory was renamed) is dropped — note it as a false positive
   so the next run is faster.

3. **Fix or report.** For a focused pass, apply the corrections directly (prefer pointing at a source of truth
   over re-stating a brittle list — e.g. "see `src/domain/value/error/` for the canonical set" instead of a
   hand-copied enumeration that will re-rot). For a broad audit, hand back a grouped report: file, the wrong
   claim, the right one, the evidence.

## Output format

When reporting (rather than directly fixing), group by severity, then by file:

```
## Drift report — <N> confirmed, <M> false positives dropped

### critical — actively misleads a session
- <file>:<line> — `<wrong>` → `<right>` (evidence: <src path / grep result>)

### medium — stale but not actively harmful
- …

### false positives (verified legitimate, left as-is)
- <candidate> — why it is fine
```

## Keeping the sweep sharp

When you confirm a _new_ class of drift (a fresh rename that recurs, a newly-fabricated symbol pattern), add
it to bucket [4] in `scripts/sweep.sh`. The known-pattern list is the cheapest early-warning — every pattern
you encode there turns a judgement call into a one-line grep for the next person. That is the whole point: the
sweep should get smarter each time the code teaches it something.

## Relationship to `verify`

`verify` answers "is the code correct?" (typecheck, lint, tests). `drift-sweep` answers "do the docs and agents
still describe the code accurately?". They are orthogonal: a repo can be fully green and still ship agents that
point at deleted files. Run `verify` before committing code; run `drift-sweep` before a release or after a
structural rename.
