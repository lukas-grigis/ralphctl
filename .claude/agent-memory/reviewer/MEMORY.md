# Memory Index

- [feedback_review_scope.md](feedback_review_scope.md) — Full-branch review procedure, the `_shared` import blind spot, and the scratchpad-tsconfig recipe for scoped typechecks
- [feedback_typecheck_probe.md](feedback_typecheck_probe.md) — Verify a "compile-time forcing function" claim with a scratchpad tsc probe (literal-widening → `never` trap)
- [project_memory_ledger.md](project_memory_ledger.md) — Learnings ledger, distill sub-chain, per-task attempt outer loop, task-graph validation — and what to check when reviewing them
- [project_windowed_list_review.md](project_windowed_list_review.md) — Windowed-list findings plus the headered-list migration hazard: re-attached headers escape the window, `suppressScrollArrows` makes the overflow unreachable
- [project_coalesced_buffer_review.md](project_coalesced_buffer_review.md) — Rolling-window buffer vs append-style sink: the duplicate-emission bug class, and why one-flush-per-test misses it
- [project_esc_collapse_claim_seam.md](project_esc_collapse_claim_seam.md) — Esc-collapse-before-pop: claimEscape suppresses the pop, the panel keymap collapses; undefined-sentinel ref establishes the mount-time claim
- [project_duplicate_codex_effort_clamp.md](project_duplicate_codex_effort_clamp.md) — RESOLVED: one `clampEffortToProvider` implementation; re-grep for effort-floor literals on any effort-vocabulary diff
- [project_model_refresh_review_2026-07-26.md](project_model_refresh_review_2026-07-26.md) — What the catalog-fingerprint gate catches versus where model-bump drift actually lands
- [project_unwired_ratelimit_jitter.md](project_unwired_ratelimit_jitter.md) — RESOLVED: applyJitter wired; durable lesson — knip stays green on test-only exports, so grep `src/` for a real caller
- [project_eslint_sibling_isolation_dead.md](project_eslint_sibling_isolation_dead.md) — RESOLVED via mergeRestrictedImports; durable lesson — flat config REPLACES same-key rule entries, verify fences by probe
- [project_plan_checks_conformance_firstrun_review.md](project_plan_checks_conformance_firstrun_review.md) — Literal NUL bytes in a test file (git renders it binary) and demo `--script`'s checkCli skip scoped to implement only
