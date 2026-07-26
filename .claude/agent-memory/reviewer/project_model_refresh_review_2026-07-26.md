---
name: project-model-refresh-review-2026-07-26
description: Review of the Opus 5 / GPT-5.6 provider model-catalog refresh — what the catalog-fingerprint gate does and does NOT catch
metadata:
  type: project
---

Reviewed the provider model-catalog refresh (Claude Opus 5, GPT-5.6 Sol/Terra/Luna, codex effort
`low..ultra`, Fable un-suspended) on 2026-07-26. All five gates green; one major finding
(see [[duplicate-codex-effort-clamp]]), the rest doc/comment drift.

**Why this matters for future model bumps:** the catalog-fingerprint test
(`tests/unit/business/task/escalation-map.test.ts`) is a genuinely strong fence — it caught nothing
wrong here because the ladder lockstep assertions really do cover orphaned rungs, and the three recorded
hashes reproduce exactly when recomputed independently (sha256 of the sorted ids, first 16 hex chars).
Recomputing them yourself is a cheap, high-value check that the implementer ran the test rather than
hand-writing hashes.

**What the fence does NOT cover, and where drift actually lands:**

- duplicated behaviour outside the catalogs (the readiness effort clamp — the one real bug)
- doc comments naming specific model ids / effort vocabularies in the provider adapters
  (`codex/headless.ts`, `_engine/ai-session.ts`), `resolve-agent-override.ts`, and the TUI docblocks
  (`settings-editor.tsx` suspension examples, `settings-view-model.ts` chain example,
  `header-card.tsx` provider/model pairing)
- suspension-guard comments that name the model that was suspended, once the list goes empty

**How to apply:** on the next model bump, verify the fingerprints independently, then grep the id strings
and effort-level strings across `src/` (not just the changed modules) — the comment drift list above is
the same set every time.
