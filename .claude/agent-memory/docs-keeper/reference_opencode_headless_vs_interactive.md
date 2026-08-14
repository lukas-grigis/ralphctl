---
name: reference_opencode_headless_vs_interactive
description: SECURITY.md's OpenCode paragraphs mix headless (--auto) and interactive (buildOpencodeEnv config grant) mechanisms — easy to conflate when editing either one
metadata:
  type: reference
---

`SECURITY.md`'s OpenCode coverage describes TWO distinct directory-grant mechanisms that are easy to
conflate because they sit in the same paragraphs and both exist "because OpenCode has no `--add-dir`":

- **Headless** (`opencode run` — implement generator/evaluator, review, create-pr, readiness,
  detect-scripts, detect-skills; backed by `providers/opencode/headless.ts`) grants access by emitting
  `--auto` wholesale whenever a mounted root falls outside `--dir`. No per-root scoping exists on this
  path.
- **Interactive** (TUI handoff — ideate, plan, refine; backed by `providers/opencode/interactive.ts`)
  has NO `--auto` flag on the default command at all. It grants access via
  `buildOpencodeEnv` → an `OPENCODE_CONFIG_CONTENT` env overlay setting `permission.external_directory`
  per root.

**Why this matters:** on 2026-08-14 (issue #278 fix — `buildOpencodeEnv` widened from prompt-dir-only to
every engine-folded root, now `Result`-returning) I initially drafted a SECURITY.md edit that called
`headless.ts` a "mirror" of `buildOpencodeEnv` and attributed `--auto` to the `ideate` flow. Both were
wrong — `headless.ts` was untouched by that PR and still only does `--auto`; `ideate` is interactive and
never touches `--auto` at all. Ground the flow-to-mechanism mapping by grepping
`grep -rln interactiveAi src/application/flows/*/deps.ts` (interactive: ideate, refine, plan today) before
writing anything that names which flows use which OpenCode grant mechanism.

**How to apply:** any SECURITY.md edit touching OpenCode must state explicitly which surface
(headless/interactive) a sentence is about — the doc already does this in most places, don't let an edit
blur it back together.

Related: [[project_high_drift_areas]].
