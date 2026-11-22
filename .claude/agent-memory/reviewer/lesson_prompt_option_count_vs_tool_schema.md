---
name: lesson_prompt_option_count_vs_tool_schema
description: A prompt rule that sets the number of options in a structured question ("offer X alone") must be checked against each provider's question-tool schema; the eval forces the no-tool branch and cannot see it
metadata:
  type: feedback
---

When a template tells the model how many options to offer (one, five, none), check it against the
real structured question tool of each interactive provider. Claude Code's `AskUserQuestion` documents
"Must have 2-4 options" and adds its own free-text "Other"; a one-option question is a schema error,
and the model's natural repair is to add a second option it makes up, which can defeat the rule's
purpose (e.g. a no-invention rule).

**Why:** the gate cannot see this. Definition tests only read template prose, and the refine eval
adapter appends a "no structured question tool" line to the question-format partial, so every eval
trial runs the plain-text branch.

**How to apply:** for any prompt diff that changes option counts or option shape, grep the installed
CLI for the schema text: `strings -n 8 ~/.local/share/claude/versions/<v> | grep 'Must have 2-4'`
(also `kind "text"` for the open-question variant). Copilot/Codex tools differ; say which you checked.
Related: [[lesson_prompt_contract_restated_invariants]] — a carve-out that names one member of a group
("an unknown outcome is not such a gap") leaves the siblings (signal, assumptions) under the general rule.
