---
name: relaxed-validator-consumer-audit
description: When a value-object validator is loosened, audit who relied on the rejection (shell, regex, replace, env-var typos) and whether a narrower relaxation keeps the useful half
metadata:
  type: feedback
---

`AbsolutePath.parse` used to reject `~` and `$VAR` anywhere. It now rejects only non-absolute input, so `/srv/${TEAM}/ralph`
and `/a/$(whoami)/b` parse OK. `RALPHCTL_HOME` set to an unexpanded `${VAR}` form therefore creates a literal `${TEAM}`
directory tree under `/srv/`, where it used to fail with a clear message. The TUI repo picker still stats the directory,
so the damage is limited to the storage root. Verified with a tsx probe on `resolveStoragePaths`.

Checks that came back clean for this relaxation (reuse the list): no `sh -c` / `bash -lc` / `cd "<path>"` interpolation
in `src/` (the only `shell: true` runner takes the path as `cwd`); the prompt substituter uses a function replacer so `$&`
in a path is not interpreted (`prompts/_engine/substitute.ts`); no `new RegExp` built from a path. One theoretical
leftover: `ui/tui/components/format.ts` calls `line.replace(path, <string>)`, which would interpret `$&` / `$$` in a path.

**Why:** the audit proposed "drop the env-var test"; the braced `${...}` form is never a real directory name while `$build`
is, so a narrower relaxation (still reject `${`) would have kept the typo guard for free.

**How to apply:** for any validator relaxation, grep the consumers for the three interpretation sites above and ask
whether a split rule (legal chars vs. obvious-typo syntax) is available before accepting the blanket loosening.

**Sink the "clean" list above missed:** prompt templates that tell the model to run a shell command with the path inside
double quotes. `create-pr/template.md` has `git -C "{{REPOSITORY_PATH}}" log ...` (the only `"{{...PATH` sink; grep
`"{{[A-Z_]*PATH`), so a repository at `/srv/$build/app` makes the model's shell expand `$build`. Substitution is safe,
the instruction text is not. Treat prompt-embedded shell snippets as consumers alongside `sh -c`.
