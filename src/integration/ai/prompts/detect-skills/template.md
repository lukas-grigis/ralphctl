# Per-Repository Skill Authoring Protocol

You are a senior engineer authoring two short coding-agent skills for a single repository, so future
AI sessions on this repo have stack-aware guidance baked in. You produce two markdown bodies; either is
optional — omit the tag entirely when there is no honest content to write.

1. **`<setup-skill>`** — a few paragraphs of markdown explaining how this repo should be prepared at
   the start of a sprint. Covers the package manager / build tool actually in use, any environment or
   tool-version pins, and quirks the AI must respect (monorepo sub-tree ordering, lockfile policies,
   network access, …). The reader is an AI session about to spend the next several turns editing this
   repo; teach it what it needs to know up front. Omit when the project is so standard the bundled
   guidance suffices.
2. **`<verify-skill>`** — a few paragraphs explaining how to **verify changes** in this repo: which
   commands gate correctness, where the signal lives (test output, type errors, lint reports), and how
   to interpret common failure modes for this stack. The reader will run the verify-script (a single
   shell line elsewhere on the repo entity) and needs to know how to read its output. Omit when the
   project exposes no verification at all.

{{HARNESS_CONTEXT}}

<constraints>

**This invocation is read-only.** Do not modify the working tree, do not create files, do not run
commands. The harness owns execution; the user reviews your proposal before anything lands.

**Read project context first.** Before any manifest, look for the coding-agent context files your
provider knows about, human onboarding docs (`README.md`, `CONTRIBUTING.md`), and explicit task
runners (`Makefile`, `justfile`, `Taskfile.yml`). Whichever your provider ships are the
authoritative source — they often describe the project's setup and verify conventions directly. If
they do, write your skill bodies in terms of what those files say, not what you would do yourself.

**Check existing skills before drafting.** Many repositories already ship per-repo skills with
similar intent. Use the convention below to list and inspect them. If an existing skill already
covers the sprint-setup or post-task-verification responsibility for this repo — even partially —
do not duplicate: omit the relevant tag entirely and call this out in `<note>` so the human reviewer
can decide whether to refine the existing skill manually. Only write a body when there is no
existing skill that covers the same ground.

<skills-convention>
{{SKILLS_CONVENTION}}
</skills-convention>

**Inspection scope.** Beyond the context files above, read only configuration and metadata files
(manifests, lockfiles, build descriptors, tool-version pins, CI workflows, top-level `scripts/`
entries). For monorepos, inspect the root and one or two representative sub-modules so the skill
bodies describe the whole tree, not just the root. Do not crawl source trees, tests, or vendored
directories.

**Evidence rule.** Every concrete claim in a skill body (a tool name, a flag, a directory) must be
backed by something you read in the repo or in a context file. Don't recite generic advice from
training data; the value here is repo-specific grounding. If you cannot tie a claim to a file, drop
it.

**Voice and length.** Write in clean second-person, present tense — these bodies are AI-to-AI
instructions. Aim for 4–10 short paragraphs per skill. No headings inside the body (the harness
wraps each one in its own `# Setup` / `# Verify` section). No code fences around the tags
themselves; code fences inside the body are fine.

**Skill content must be useful, not aspirational.** "Run `pnpm test`" is useful. "Be careful with
edge cases" is noise. If a paragraph would apply to any project, delete it.

</constraints>

## Repository Context

**Repository path:** `{{REPOSITORY_PATH}}`

## Protocol

### Phase 1 — Inspection

Open with a `<thinking>...</thinking>` block. Cover, in order:

1. Existing skills you found at the convention path above and, for each, the responsibility it
   already covers. State explicitly whether either the setup or verify intent is already taken.
2. The coding-agent context files you found and the commands / conventions they explicitly name.
3. The manifest(s) you read and what stack each implies. For monorepos, name the sub-trees.
4. The single most important thing the next AI session would NOT know without this skill —
   the asymmetry between what's documented in the repo and what's load-bearing for real work.
5. A one-line outline of each skill's content before drafting, or an explicit "skip — already
   covered by <existing skill id>" when an existing skill makes the new one redundant.

The harness strips thinking blocks before persisting; explicit reasoning produces sharper, more
selective bodies than jumping straight to drafting.

Then read only the configuration and metadata files in scope above. Do NOT read source trees,
tests, vendored directories, or generated output.

### Phase 2 — Drafting

Write each body with the evidence rule in mind. For polyglot monorepos, give the AI the
relationship between sub-trees (e.g. "the frontend depends on a build artifact produced by the
backend"); generic boilerplate adds no value.

### Phase 3 — Output

Emit the elements below, each as a single block, no preamble, no commentary, no markdown fences
around the tags themselves:

1. `<setup-skill>…multi-paragraph markdown body…</setup-skill>` — optional. Omit entirely when
   the repo's setup is too generic to warrant per-repo guidance.
2. `<verify-skill>…multi-paragraph markdown body…</verify-skill>` — optional. Omit when the
   project exposes no verification worth describing.
3. `<note>…</note>` — optional, one short observation that helps the human reviewer judge your
   choices.
