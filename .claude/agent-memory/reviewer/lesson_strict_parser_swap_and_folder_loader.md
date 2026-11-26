---
name: lesson_strict_parser_swap_and_folder_loader
description: Swapping a lenient frontmatter reader for a strict YAML parser, or widening a skill loader to whole folders, silently drops operator content that used to load; probe a real-world corpus
metadata:
  type: feedback
---

When a diff replaces a naive `key: value` reader with a strict YAML parser (`yaml` with `strict`/`uniqueKeys`),
probe a corpus of REAL third-party files, not the repo's own fixtures. `description: Use when: X` (unquoted
colon) is invalid YAML yet common in published SKILL.md / agent files that Claude Code accepts; the strict
path turns every such operator skill into a "skipped" warning, and a flat projection (`parseSimpleYaml`)
returning `{}` on parse failure makes agent definitions fail with a misleading "name required" error.

Probe recipe: a scratchpad tsx script that walks `~/.claude/plugins` + `~/.claude/skills` + repo `.claude/`,
runs `splitFrontmatter` + the new parser, prints failures. Run with
`npx tsx --tsconfig tsconfig.json <scratchpad script>` from the repo root (avoid top-level await; wrap in
`main()`). Never copy the probe into the repo tree.

Folder-skill loaders: check what a spec-valid but non-text file does. A UTF-8-fatal decoder over `assets/`
(images are spec-legal there) skips the whole skill on the run path AND, if the catalog reads installs
through the same helper, fails the entire catalog `list()` for one manual folder. Also check: exec bit
lost on `scripts/` written through a text writer; renderer bare-emitting typed-looking strings (`1.0`,
`true`, `null`).

"Removed skill is ignored" claims (changelog, docs): grep every source that enumerates directories
(phase / operator loaders) rather than the registry — copies made by an older catalog keep loading.

**Why:** the unit tests for a parser swap only cover the shapes the author thought of; the regression is
in content the repo doesn't own. **How to apply:** any diff touching `frontmatter.ts`, `parse-skill.ts`,
`skill-folder-loader.ts`, `skill-support-files.ts` or a "removed X" changelog line.

Gate note: full `pnpm test` under host load avg >100 produced 14 TUI timeouts in untouched files; rerun
the failing files in isolation before reporting them.
