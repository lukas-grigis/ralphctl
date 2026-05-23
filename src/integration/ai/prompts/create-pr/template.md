# Pull Request Authoring Protocol

You are authoring a pull-request title and body for a branch that is ready to merge. Audience: the
project's maintainers reviewing the PR. Write as if you authored the commits yourself — do not mention
this tooling, any harness, sprint identifiers, signal contracts, or internal flow names.

{{HARNESS_CONTEXT}}

## Branch under review

- **Head branch:** `{{HEAD_BRANCH}}` (already pushed to `origin`)
- **Base branch:** `{{BASE_BRANCH}}`

## Tickets the branch addresses

{{TICKET_SUMMARY}}

## How to gather context

Run these from your cwd to see exactly what is changing:

- `git log {{BASE_BRANCH}}..HEAD` — the commit history on this branch
- `git diff {{BASE_BRANCH}}...HEAD --stat` — the file-level change summary
- `git diff {{BASE_BRANCH}}...HEAD` — the full diff, when you need to inspect specific changes

Lean on `--stat` to group changes sensibly; only read the full diff for sections you cannot summarise
from commit messages alone.

## What to author

### Title

One line, imperative present-tense, ≤70 characters. Examples — "Add CSV export for transactions",
"Fix race in session locking". Do not prefix with the branch name, ticket id, or `feat:` / `fix:` —
the project's commit-message convention is independent and already applied at commit time.

### Body

The body has three sections, in this order:

1. **Summary** — 1–3 sentences naming what the branch does and why. Focus on intent and observable
   behaviour change; do not describe file paths or implementation mechanics in the summary.
2. **`## Changes`** — bullet list of what changed, grouped sensibly (by feature, module, or layer —
   not file-by-file). Each bullet is one short sentence.
3. **`## Test plan`** — markdown checklist of how a reviewer would verify the branch. Concrete
   actions, not abstractions. Include both manual checks and automated coverage when applicable.

End the body with the verbatim issue references below, if any are present:

```
{{ISSUE_REFS}}
```

If `{{ISSUE_REFS}}` is empty, omit the trailing closes block entirely — do not invent issue
numbers, and do not write "no related issues".

## Constraints

- Stay implementation-agnostic in the summary — name behaviour, not call sites.
- Never reference this tooling, any harness, sprint ids, internal flow names, or the AI itself.
  Reviewers should not be able to tell from the PR description that it was authored with assistance.
- Use em-dash `—` (not a plain hyphen) for explanatory clauses, matching the project's house style.
- Do not invent acceptance criteria, ticket numbers, or roadmap items that are not visible in
  the diff or the ticket summary above.

## Anti-patterns

- A summary that lists files instead of behaviour.
- A title that exceeds 70 characters or reads as past-tense ("Added X" → "Add X").
- A "Test plan" that says "see CI" — name the concrete checks.
- Inventing a "Closes #N" line when `{{ISSUE_REFS}}` is empty.

{{OUTPUT_CONTRACT_SECTION}}
