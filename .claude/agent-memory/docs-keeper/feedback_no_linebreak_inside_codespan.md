---
name: feedback-no-linebreak-inside-codespan
description: Never hand-wrap a long inline code span across two source lines in a .claude/docs/*.md edit — the repo's format-on-save hook mangles the continuation line's indentation
metadata:
  type: feedback
---

This repo's `.claude/hooks/format-edited-file.sh` PostToolUse hook runs the repo's own `prettier
--write` on every `.md` file right after an Edit/Write. If an Edit inserts a long inline code span
(backtick-delimited, e.g. a `{ outcome: '...', seenPaths: [...] }` type sketch) and the code span
itself is hand-wrapped across two source lines inside a `-`/`*` list item, prettier's markdown
formatter strips the list-item continuation indent (2 spaces) off the second line — it renders fine
in most Markdown viewers (paragraph continuation doesn't require indent absent a blank line) but
reads as a formatting bug in a raw diff and breaks the visual list-alignment convention every other
bullet in these docs follows.

**Why:** confirmed by direct reproduction while editing `ARCHITECTURE.md § Data Models` (the
`SprintExecution.tree` bullet) on 2026-09-17 — Read-the-file-after-edit caught it before commit.

**How to apply:** when a new type sketch or object literal needs describing inline in a doc bullet,
either (a) keep the whole inline code span on one source line (let it run long — printWidth is 120
but prettier's markdown mode won't split inside a code span anyway, so this is safe), or (b) describe
the shape in prose/parentheses instead of one big backtick blob. After any edit that adds a
multi-line-spanning code span to a `.claude/docs/*.md` bullet, `Read` the file back (or `git diff`) to
confirm the hook didn't mangle the indent — the hook is silent (`--log-level=warn`, stderr
discarded), so it won't tell you.

Two more pre-existing instances (not introduced by that edit, just noticed in passing) turned up the
same day: a `blockCause:` / `'worktree-setup-failure'` pair split across two lines in
`ARCHITECTURE.md`, and a `restore-blocked-` / `diff.ts` pair split across two lines in `WORKFLOWS.md`.
The second one was left alone because it predated the current uncommitted batch (out of scope for that
pass); the first was fixed because it was part of the in-flight uncommitted diff.

Audit trick: diff for ADDED lines only (so it doesn't flag pre-existing, out-of-scope wraps), split
each on the backtick character, and flag a line whose backtick count is odd — that means the line
opens or closes a code span the next line completes. Ask a subagent or run it directly rather than
inlining the backtick-containing command in a doc bullet (see the mangling this very sentence almost
caused).
