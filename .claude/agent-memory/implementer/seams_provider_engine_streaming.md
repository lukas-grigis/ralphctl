---
name: seams_provider_engine_streaming
description: Provider adapter engine — the one shared rate-limit retry loop, empirical stream field names, OOM caps on stdout parsing, and the kill-escalation ladder
metadata:
  type: project
---

Files: `integration/ai/providers/_engine/{run-with-rate-limit-retry,run-provider-attempt,bounded-tail,abort-kill,idle-watchdog}.ts`,
`providers/<tool>/{headless,interactive,parse-stream}.ts`, `integration/io/kill-with-escalation.ts`.

## ONE rate-limit retry loop for every headless adapter

`_engine/run-with-rate-limit-retry.ts` is the single retry loop; every headless adapter reaches it
through `run-provider-attempt.ts` (`runProviderAttempt` / `createHeadlessProvider`). It replaced ~70
lines of near-identical loop that had been copied per adapter.

**Why centralising mattered:** the copied loops built argv ONCE before the loop and reused it verbatim,
so the sessionId `classifySpawnExit` captured onto a `RateLimitError` was never consumed — a 429 retry
cold-started instead of resuming the interrupted session.

- **The seam:** the adapter passes `attempt(session)` which builds its OWN argv from the CURRENT session.
  On a rate-limit outcome with `error.sessionId` defined, the loop rebuilds the next session as
  `{ ...session, resume: id }`, so the per-attempt argv builder naturally emits `--resume` /
  `exec resume`. **Adapters never re-implement backoff, banners, abort-during-backoff, or resume.**
- **Stale-resume cold fallback** is shared via the optional `resumeStaleRe` param (it was codex-only).
  It drops `resume` for ONE cold respawn (latched) and re-runs the SAME attempt index, so it does NOT
  consume a rate-limit slot. Each adapter passes its own regex; codex keeps
  `/no rollout found|thread\/resume failed|code -32600/i`.
- **Rate-limit detection scans stderr PLUS a per-adapter `stdoutTail`** fed to `classifySpawnExit` —
  providers report quota on stdout, not stderr. The regexes are broader than bare `/rate.?limit/i`
  (claude adds `usage limit reached|5-hour limit|overloaded_error|429`; others add `quota|429`).
- `applyJitter` is wired into `handleRateLimitOutcome`'s `delayForRetry → sleepCancellable` hop, with an
  injectable `random` option.

**Operator knob:** `settings.harness.idleWatchdogMs` (60_000–3_600_000, default 300_000), threaded
`provider-factory.ts` → each adapter's `deps.idleMs`. **Adding a harness field touches:** settings.ts
schema, defaults.ts, apply-key.ts (numeric case + help string), settings-view-model.ts (HARNESS_HINTS +
field row), and the test fixtures that build full `harness` literals. The escalation-map TUI test counts
knob rows to reach the map-add row — bump the `j`-press count when adding one.

## Empirical stream field names (re-capture before trusting)

Captured against the installed CLIs on 2026-05-26; vendors tweak these shapes between releases.

- **codex-cli 0.130.x** (`headless.ts` `consumeMetaLines`): the session id is **`thread_id`** on the
  leading `{"type":"thread.started","thread_id":"<uuid>"}` record — NOT `session_id`. Usage sits on the
  trailing `{"type":"turn.completed","usage":{...}}`. That `thread_id` UUID is what `codex exec resume
<id>` accepts, so it round-trips through `session.resume`. The parser recognises `thread_id` first,
  then legacy `session_id`/`sessionId`.
- **copilot 1.0.51** (`parse-stream.ts` / `headless.ts`): the session id is `sessionId` on the TRAILING
  `{"type":"result",…,"sessionId":"<uuid>"}` record, not a leading meta line. First-`sessionId`-wins is
  safe because only the `result` record carries that key. `result.usage` has no token counts
  (premiumRequests/durations only); `outputTokens` appears on `assistant.message` records.

**How to apply:** if session capture or token usage looks broken again, re-capture live stdout before
editing a parser — e.g. `printf 'say hi' | codex exec --skip-git-repo-check --json -` and
`copilot --output-format=json -p "say hi"`. There is no `timeout` binary on macOS; run the capture bare.

## OOM caps on stdout parsing

Two uncapped accumulators sat in the same OOM class as the TUI render-path leak. Both are bounded now,
with the cap constants in ONE home so siblings cannot drift — `_engine/bounded-tail.ts`:
`STDERR_TAIL_CAP` 16 KiB, `RATE_LIMIT_SCAN_TAIL_CAP` 8 KiB, `STDOUT_LINE_PARSE_CAP` 512 KiB,
`FORENSIC_BODY_TAIL_CAP` 256 KiB.

- **NDJSON line accumulator** (`claude/parse-stream.ts`, `copilot/parse-stream.ts`): both grew
  `buffer += chunk` until a newline; a single record embedding a large file-read or bash result inflated
  one line to tens of MB. Fixed with an `appendCapped(chunk)` closure — the SOLE append site (`feed`
  calls it; `flush` only drains, so the invariant holds) — trimming to the TAIL at
  `STDOUT_LINE_PARSE_CAP`. Tail-trim, not head-trim, so the record's terminating `}`/newline still lands
  in-window.
- **copilot `headless.ts` `events[]`** retained every stdout line for the whole spawn, and its
  `assistant` boolean tag was VESTIGIAL — neither consumer filtered on it, because signals come from
  `signals.json` via the file-based contract, not by re-parsing the body. Replaced by two
  `createBoundedTail`s fed through a `recordLine(text)` helper: `forensicTail` (→ body.txt) and
  `rateLimitTail` (→ classifier haystack).

**Non-obvious: warning from a pure parser with no EventBus.** The parsers are pure factories (no deps,
no bus). Use `console.warn` behind a one-shot latch (`let overflowWarned = false`) — the established
project pattern, mirroring `in-memory-event-bus.ts`, `heap-watchdog.ts`, `broadcast-sink.ts`. Do NOT
change the parser factory signature to inject a logger: non-owned callers construct these with no args.

## Kill escalation

`integration/io/kill-with-escalation.ts` is the shared SIGTERM → grace → SIGKILL helper for the
external-command runners (`run-cli.ts`, `run-command.ts`, `git-runner.ts`). It is an INTENTIONAL second
copy of the ladder in the AI-provider engine (`_engine/abort-kill.ts` / `idle-watchdog.ts`) because
`integration/io/` must not import the AI-provider `_engine/` under sibling isolation.

The runners settle their result promise the instant the timeout trips, so a bare
`child.kill('SIGTERM')` never reaped a wedged git/gh child that ignores SIGTERM — it could hold
`.git/index.lock` forever. `killWithEscalation` sends SIGTERM, schedules an `unref`'d SIGKILL after the
grace, and clears it on the child's `exit` so a recycled pid is never signalled. Promise semantics are
UNCHANGED: the escalation reaps in the background.

**How to apply:** any new external-process runner in `integration/io/` kills via `killWithEscalation`,
not a bare SIGTERM. Test with `vi.useFakeTimers()` + `advanceTimersByTime(grace)` — grace is injectable.

## Interactive adapter abort seam

`attachAbortKill` in `providers/<tool>/interactive.ts` was dead code until the interactive leaf call
sites (`refine-ticket-interactive`, `call-planner-interactive`, `ideate-and-plan`,
`_shared/memory/distill-propose`) forwarded `execute(input, signal)` → `interactiveAi.run({ abortSignal })`.
**The adapters classify abort BEFORE the exit-code branch** (mirroring `classifySpawnExit` step 1) so a
SIGTERM'd cancel surfaces `AbortError`, not `InvalidStateError`.

**Lint ratchet gotcha in these files:** their `run()` methods already sit over the
`max-lines-per-function` cap, and `sonarjs/no-duplicate-string` trips at 3 identical bare string
literals. Reuse the module-level `const PROVIDER = 'interactive-<x>'` for both `entity` and
`elementName` rather than re-typing the literal.

Related: [[seams_provider_conformance_and_demo]], [[seams_chain_runner_core]],
[[seams_model_catalog_refresh]].
