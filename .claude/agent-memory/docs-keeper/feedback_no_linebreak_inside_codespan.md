---
name: feedback-no-linebreak-inside-codespan
description: Keep an inline code span on one source line in doc bullets; the format hook can strip the continuation indent
metadata:
  type: feedback
---

Don't hand-wrap an inline code span across two lines in a `.claude/docs/*.md` list item: `format-edited-file.sh` runs
prettier on save and the continuation indent can be lost (unreproduced on prettier 3.9.8; cheap to avoid). Keep the span
on one line or describe the shape in prose, and `git diff` after the edit.
