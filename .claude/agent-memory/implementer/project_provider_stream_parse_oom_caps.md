---
name: provider-stream-parse-oom-caps
description: OOM-hardening of provider stdout stream parsing — STDOUT_LINE_PARSE_CAP on the NDJSON line accumulator in both parsers + bounded forensic/rate-limit tails replacing copilot headless events[]; pure-parser warnings use console.warn one-shot latch (no bus available).
metadata:
  type: project
---

Provider stdout stream parsing had two uncapped accumulators in the same OOM class as the
PR #229 TUI render-path leak (commit 821f7bff). Both fixed by bounding in `_engine/bounded-tail.ts`.

**The cap constants now living in `_engine/bounded-tail.ts`** (one home so siblings can't drift):
`STDERR_TAIL_CAP` (16 KiB), `RATE_LIMIT_SCAN_TAIL_CAP` (8 KiB), `STDOUT_LINE_PARSE_CAP` (512 KiB),
`FORENSIC_BODY_TAIL_CAP` (256 KiB).

**C1 — NDJSON line accumulator (`claude/parse-stream.ts` + `copilot/parse-stream.ts`).** Both grow
`buffer += chunk` until a newline ends the current line; a single record embedding a large
file-read / bash result inflated one line to tens of MB. Fix: an `appendCapped(chunk)` closure (the
SOLE append site — `feed` calls it; `flush` only drains, so the invariant holds there too) that
trims `buffer` to the tail at `STDOUT_LINE_PARSE_CAP`. Tail-trim (keep last N) so the record's
terminating `}`/newline still lands in-window when it arrives.

**C2 — copilot `headless.ts` `events[]`.** A `let events: Array<{assistant, text}>` retained every
stdout line for the whole spawn. The `assistant` boolean tag was VESTIGIAL — neither consumer ever
filtered on it (signals come from signals.json via the file-based audit-[09] contract, not by
re-parsing the body). Replaced with two `createBoundedTail`s fed via a `recordLine(text)` helper:
`forensicTail` (FORENSIC_BODY_TAIL_CAP → body.txt) and `rateLimitTail` (RATE_LIMIT_SCAN_TAIL_CAP →
classifier haystack). Consumers became `forensicTail.value()` / `rateLimitTail.value()`. Trailing
`\n` per recorded line differs harmlessly from the old `.join('\n')`.

**Non-obvious: surfacing warnings from a pure-factory parser with no EventBus.** The parsers are
pure factories (no deps, no bus). Use `console.warn` guarded by a one-shot latch
(`let overflowWarned = false`) — this is the established project pattern, mirroring
`integration/observability/in-memory-event-bus.ts` (warn once per instance so a sustained
condition doesn't itself spam the console). `heap-watchdog.ts` / `broadcast-sink.ts` do the same.
Do NOT change the parser factory signature to inject a logger — `claude/headless.ts` (a non-owned
caller) constructs `createClaudeStreamParser()` with no args.

Related OOM-cluster memories: [[project_eventbus_branch_listener_leak]],
[[project_tui_commit_storm_coalescer]], [[project_ledger_compaction_dedup_asymmetry]].
