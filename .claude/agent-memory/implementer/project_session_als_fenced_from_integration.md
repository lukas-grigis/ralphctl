---
name: session-als-fenced-from-integration
description: currentSessionId() ALS helper lives in application/ and is lint-fenced from integration; the "deep adapters read currentSessionId()" pattern in CLAUDE.md is not actually wired
metadata:
  type: project
---

`currentSessionId()` / `runWithSession()` live in `src/application/session/session.ts`. The ESLint
integration fence (`eslint.config.ts` ~line 618, `restrictImports(['application'])` over
`src/integration/**`) bans `**/application/**` imports — and it applies to provider files too
(the per-provider sibling-isolation block at ~line 474 sets `siblingIsolationRule`, but the
later integration block re-applies the application ban; last-matching flat-config wins per rule).
Verified empirically: importing it into `src/integration/ai/providers/*/headless.ts` produces
`Layer dependency violation: cannot import from 'application'`.

So as of the `ui-ux-stabilization` branch, NO integration adapter actually reads the ALS session
id — CLAUDE.md's "deep adapters can read `currentSessionId()` and tag logs / signals" is
aspirational, not wired. The only `currentSessionId` consumer is `application/chain/run/runner.ts`.

**Why:** `node:async_hooks` is NOT in the `nodeIoBans` list, so the ALS helper is pure enough to
live in `business/observability/` (importable by both integration and application). It only sits in
`application/` for historical reasons.

**How to apply:** Any task that needs an integration adapter (provider headless, signal sink) to
read the chain runner id must FIRST relocate the ALS helper to `business/observability/session.ts`
(or domain) and update the `runner.ts` / `wave-scheduler.ts` / `parallel-element.ts` import. You
cannot satisfy "stamp from currentSessionId() in a provider" without that relocation — the import
is a hard lint error otherwise. Relevant to [[project_provider_stream_session_fields.md]] (provider
uuid `sessionId` is a different id space from the runner id).
