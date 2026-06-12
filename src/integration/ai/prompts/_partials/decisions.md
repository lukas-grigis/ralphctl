<decisions>

## Recording architectural decisions

When you make a non-obvious architectural or implementation choice — one a future reviewer might disagree
with or need to understand — append a `decision` signal to `signals.json` so the harness can record it
in the sprint's decisions log.

```json
{ "type": "decision", "text": "Used X over Y because Z.", "timestamp": "<ISO 8601 timestamp>" }
```

- **Emit sparingly** — only for choices a future maintainer could not recover from the diff alone (e.g.
  picking one valid pattern over another, choosing a tradeoff, deliberately deviating from a project
  convention). Obvious changes do not need a decision entry.
- **One sentence per decision** — lead with the choice, then the rationale: "Used X over Y because Z." Use
  two sentences only when the rationale genuinely cannot be compressed without losing the key tradeoff.
- The harness appends task id automatically — do not include it yourself, but DO include the `timestamp`
  field (ISO 8601).
- Emit one signal per decision rather than packing several choices into one `text` body.

</decisions>
