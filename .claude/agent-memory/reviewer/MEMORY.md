# Reviewer Agent Memory

- [feedback_review_scope.md](feedback_review_scope.md) — Reviewing full feature branches; check all new/changed files
  top-to-bottom, run all four checks — plus the scratchpad-tsconfig recipe for scoped typechecks
- [feedback_typecheck_probe.md](feedback_typecheck_probe.md) — Verifying a "compile-time forcing function" claim with a
  scratchpad tsc probe when the workflow forbids pnpm typecheck (literal-widening → `never` trap)
- [project_memory_ledger.md](project_memory_ledger.md) — Theme 6 procedural memory: append-only NDJSON ledger, distill
  sub-chain, attempt outer loop, task-graph validation
- [project_windowed_list_review.md](project_windowed_list_review.md) — Windowed-list / ScrollRegion findings + the headered-list migration hazard: re-attached headers escape the window, and suppressScrollArrows makes the overflow unreachable
- [project_coalesced_buffer_review.md](project_coalesced_buffer_review.md) — CoalescedBuffer onCritical window-not-cleared bug + double-seed nit from 0.10.0 commit-storm fix
- [project_esc_collapse_claim_seam.md](project_esc_collapse_claim_seam.md) — Wide Implement view Esc-collapse-before-pop: claimEscape suppresses pop, keymap collapses; undefined-sentinel ref establishes mount-time claim
- [project_duplicate_codex_effort_clamp.md](project_duplicate_codex_effort_clamp.md) — RESOLVED: readiness's duplicate codex effort floor deleted + pinned by a test; watch for a new copy appearing outside resolve-effort.ts
- [project_model_refresh_review_2026-07-26.md](project_model_refresh_review_2026-07-26.md) — Opus 5 / GPT-5.6 refresh review: what the catalog-fingerprint gate catches vs. where drift actually lands
- [project_unwired_ratelimit_jitter.md](project_unwired_ratelimit_jitter.md) — RESOLVED: applyJitter now wired + test-pinned; durable lesson: knip can't flag test-only exports because tests are entry points
- [project_eslint_sibling_isolation_dead.md](project_eslint_sibling_isolation_dead.md) — Sibling-isolation fences under src/integration/ai/** never fire; the later general integration block replaces the rule
