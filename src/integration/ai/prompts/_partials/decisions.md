## Recording architectural decisions

When you make a non-obvious architectural or implementation choice — one a future reviewer might disagree
with or need to understand — emit `<decision>your concise rationale</decision>` so the harness can record
it in the sprint's decisions log.

- **Emit sparingly** — only for choices a future maintainer could not recover from the diff alone (e.g.
  picking one valid pattern over another, choosing a tradeoff, deliberately deviating from a project
  convention). Obvious changes do not need a decision entry.
- **One sentence per decision.** Lead with the choice, then the rationale: "Used X over Y because Z."
- The harness appends timestamp + task id + commit sha automatically — do not include those yourself.
- Multiple `<decision>` tags per task are allowed when distinct choices were made; emit one tag per
  decision rather than packing several into one body.
