# 03 — Truncation policy

**Status:** decided-change (2026-05-22)
**Related:
** [01 logs dir](01-logs-directory-layout.md), [02 signal contract](02-signal-contract.md), [07 progress vs chain.log](07-progress-vs-chain-log.md), [09 AI session contract](09-ai-session-contract.md)

## The policy in one rule

> **Truncate at the display boundary, never at the persistence boundary, for any data the operator might want to read
> back later.**

Concretely: persisted artifacts (script logs, commit messages, decisions, AI prose) round-trip verbatim. Only TUI
banners / live console lines get clipped to fit screen real estate, and only at render time.

## What this looks like per artifact

| Artifact                                                                | Persistence                                                                                                                                                             | Display                                                                                                   |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Setup-script stdout/stderr                                              | **1:1 to `<sprintDir>/logs/setup/<repo-id>.log`** — no cap, no transform ([01](01-logs-directory-layout.md))                                                            | Banner cause line: clipped to 200 chars; last 20 non-empty lines surfaced as separate log rows on failure |
| Verify-script stdout/stderr (pre + post)                                | **1:1 to `<sprintDir>/logs/verify/<task-id>/{pre,post}-attempt-<N>.log`** — no cap ([01](01-logs-directory-layout.md))                                                  | Same banner / tail-row pattern as setup                                                                   |
| Commit message (`commit-message` signal)                                | Harness-rendered `commit-message.txt` from the signal's `subject` + optional `body` — no cap ([09](09-ai-session-contract.md))                                          | Truncation only when previewing a multi-line message in a banner / list row (display clip)                |
| Decisions (`decision` signal)                                           | Inside per-spawn `signals.json` — Zod-validated, no cap. Surfaced in `progress.md` per-attempt `#### Decisions` subsections, no cap ([07](07-progress-vs-chain-log.md)) | TUI list row may clip to ~160 chars for legibility; full body on expand                                   |
| Other AI signals (`change` / `learning` / `note` / `task-verified` / …) | Inside `signals.json` — no cap                                                                                                                                          | Same display-only clip per row                                                                            |
| Framework events (LogEvent etc., bus traffic)                           | Not persisted unless `RALPHCTL_DEBUG_TRACE=1` ([07](07-progress-vs-chain-log.md))                                                                                       | LogEvent.message capped at ~1 KiB on the bus to keep memory bounded — display-layer concern               |

## Caps that are deleted

| Cap                                                                                                    | What replaces it                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SCRIPT_TAIL_BYTES = 4096` for `SetupRun.stdoutTailBytes` (`src/domain/value/script-tail-bytes.ts:10`) | Full output to `logs/setup/<repo-id>.log` ([01](01-logs-directory-layout.md)); execution.json keeps only metadata (no body, no `logPath` — naming convention is the discoverability story per [06](06-execution-json-slimming.md)) |
| `SCRIPT_TAIL_BYTES = 4096` for `SetupRun.stderrTailBytes`                                              | Same log file (stdout + stderr merged today; can split later if needed)                                                                                                                                                            |
| `SCRIPT_TAIL_BYTES = 4096` for `VerifyRun.stdoutTailBytes` (pre + post)                                | Full output to `logs/verify/<task-id>/{pre,post}-attempt-<N>.log`; tasks.json keeps only metadata, same no-`logPath` rule ([06](06-execution-json-slimming.md))                                                                    |
| `SINK_BODY_CAP = 500` for decision body in `decisions.log`                                             | `decisions.log` is deleted ([07](07-progress-vs-chain-log.md)); decisions live verbatim in `signals.json`                                                                                                                          |
| 8 MiB tail-read on `chain.log` for snapshot mining (`load-chain-log.ts:23`)                            | Snapshot reads per-spawn `signals.json` instead ([07](07-progress-vs-chain-log.md)). chain.log no longer load-bearing.                                                                                                             |
| 10 000-event queue inside `file-log-sink`                                                              | Sink itself is opt-in via `RALPHCTL_DEBUG_TRACE=1` ([07](07-progress-vs-chain-log.md)). Bus stays unbounded in normal operation — the queue existed only to backpressure the persistent writer.                                    |

## Caps that stay (display-only)

| Cap                                                              | Why                                                                 | Where                                                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Banner cause line: 200 chars                                     | Terminal real estate; non-truncated text mangles the layout         | `src/application/flows/implement/leaves/setup-script-runner.ts:242–254` and equivalent in verify |
| Banner tail rows: 20 lines × 200 chars                           | Same                                                                | Same                                                                                             |
| TUI list-row clip on decisions / changes / learnings: ~160 chars | Per-row legibility in dense lists; full body on expand              | Wherever the TUI renders these (search for the constant when migrating)                          |
| LogEvent.message on the bus: ~1 KiB                              | Keeps the in-memory bus from being held hostage by a chatty failure | `business/observability/event-bus.ts` boundary                                                   |

**Marker rule:** every display clip must mark itself in the rendered text: trailing `…` for short clips,
`…[N more lines]` for line clips, or a `▼ more` affordance in the TUI. The reader must always know they're looking at a
clip.

## Resolved (consolidated)

- Script output truncation **deleted**: setup + verify both forward 1:1 to
  `<sprintDir>/logs/...` ([01](01-logs-directory-layout.md)).
- `commit-message` truncation **deleted**: verbatim `commit-message.txt` from the AI's
  contract ([09](09-ai-session-contract.md)).
- Decision body truncation (500 chars) **deleted**: decisions live in `signals.json`; `decisions.log` itself is
  deleted ([07](07-progress-vs-chain-log.md)).
- chain.log mining caps (8 MiB tail, 10k queue) **deleted**: the file is no longer load-bearing; opt-in
  only ([07](07-progress-vs-chain-log.md)).
- AI-class artifacts (signals + prose files): no caps anywhere on persistence ([09](09-ai-session-contract.md)).

## Still open

- **Banner-cap unit ambiguity.** Today's 200-char clip is _probably_ bytes via `String.prototype.slice`, which can split
  a multi-byte UTF-8 sequence. Need to confirm and either: (a) accept the replacement-char tail; or (b) clip at grapheme
  boundaries via `Intl.Segmenter` for non-ASCII safety.

## Action items

- [ ] Delete `src/domain/value/script-tail-bytes.ts` and every `tailBytes(...)` call site
      once [01](01-logs-directory-layout.md) + [06](06-execution-json-slimming.md) land.
- [ ] Delete `SINK_BODY_CAP` and its call site in `decisions-log-sink.ts` (the sink itself is deleted
      via [07](07-progress-vs-chain-log.md)).
- [ ] Apply the display-clip marker rule wherever a clip is rendered — TUI banners, list rows, log rows.
- [ ] Audit banner-clip unit (bytes vs code units vs graphemes); decide and document.
- [ ] When [09](09-ai-session-contract.md) lands: smoke test the commit-message → `git commit -F` path with a
      multi-paragraph commit body to confirm verbatim round-trip.
