---
name: provider-stream-session-fields
description: empirically-confirmed session-id and usage JSONL field names for codex-cli 0.130 and copilot 1.0.51
metadata:
  type: project
---

Empirically captured (2026-05-26) the real `--json` / `--output-format=json` stdout of the installed AI CLIs, for the file-based provider contract parsers in `src/integration/ai/providers/<tool>/`:

- **codex-cli 0.130.x** (`headless.ts` `consumeMetaLines`): session id is `thread_id` on the leading `{"type":"thread.started","thread_id":"<uuid>"}` record — NOT `session_id`. Usage is on the trailing `{"type":"turn.completed","usage":{"input_tokens","output_tokens",...}}`. The `thread_id` UUID is what `codex exec resume <id>` accepts, so it round-trips through `session.resume`. Parser recognises `thread_id` first, then legacy `session_id`/`sessionId` for back-compat.
- **copilot 1.0.51** (`parse-stream.ts` / `headless.ts`): session id is `sessionId` on the TRAILING `{"type":"result",...,"sessionId":"<uuid>"}` record (not a leading meta line). The existing `sessionId` recognition is correct; first-`sessionId`-wins is safe because only the `result` record carries that key. `result.usage` has no token counts (premiumRequests/durations only); `outputTokens` appears on `assistant.message` records. No code change was needed for copilot — only a doc-comment fix.

**Why:** the lead's diagnosis said codex session-id capture was broken (always undefined → no resume, no TokenUsageEvent). Confirmed against the binary.

**How to apply:** if codex/copilot session capture or token usage looks broken again, re-capture live stdout (`printf 'say hi' | codex exec --skip-git-repo-check --json -` ; `copilot --output-format=json -p "say hi"`) before editing the parser — vendors tweak these shapes between releases. There is no `timeout` on macOS; run the capture bare.
