---
name: shared-rate-limit-retry-seam
description: The three headless AI adapters share ONE rate-limit retry loop (run-with-rate-limit-retry.ts) that owns backoff/banners/abort/session-resume-rebuild/cold-fallback
metadata:
  type: project
---

`src/integration/ai/providers/_engine/run-with-rate-limit-retry.ts` is the single retry loop for
claude / codex / copilot headless adapters. Replaced ~70 lines of near-identical loop triplicated
across the three `headless.ts` files.

**Why:** the triplicated loops built argv ONCE before the loop and reused it verbatim, so the
sessionId `classifySpawnExit` captured onto a `RateLimitError` was never consumed — a 429 retry
cold-started instead of resuming the interrupted session. Centralising fixed that for all three.

**How to apply:**

- The seam: adapter passes `attempt(session)` that builds its OWN argv from the CURRENT session.
  On a rate-limit outcome with `error.sessionId` defined, the loop rebuilds the next session as
  `{ ...session, resume: id }` so the per-attempt argv builder naturally emits `--resume` /
  `exec resume`. Adapters never re-implement backoff, banners, abort-during-backoff, or resume.
- Stale-resume cold fallback (was codex-only RESUME_STALE_RE, now shared via the optional
  `resumeStaleRe` param) drops `resume` for ONE cold respawn (latched), re-running the SAME
  attempt index so it does NOT consume a rate-limit slot. claude/copilot now pass their own
  conservative regex; codex keeps its `/no rollout found|thread\/resume failed|code -32600/i`.
- Rate-limit detection scans stderr PLUS a per-adapter `stdoutTail` fed to `classifySpawnExit`
  (claude's parsed `result` body, codex's agent_message tail, copilot's events tail) — providers
  report quota on stdout, not stderr. Regexes broadened past bare `/rate.?limit/i` (claude adds
  `usage limit reached|5-hour limit|overloaded_error|429`; codex/copilot add `quota|429`).
- See [[provider-stream-session-fields]] for the empirical session-id field names per provider.

`settings.harness.idleWatchdogMs` (60_000–3_600_000, default 300_000) is the operator knob for the
idle watchdog, threaded `provider-factory.ts` → each adapter's `deps.idleMs`. Adding a harness
field touches: settings.ts schema, defaults.ts, apply-key.ts (numeric case + help string),
settings-view-model.ts (HARNESS_HINTS + field row), and 4 test fixtures that build full `harness`
literals (provider-factory{,-rows}.test.ts, json-settings-repository.test.ts ×2). The escalation-map
TUI test counts knob rows to reach the map-add row — bump the `j`-press count when adding a field.
