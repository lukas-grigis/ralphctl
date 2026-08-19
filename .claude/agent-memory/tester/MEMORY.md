# Memory Index

- [reference_test_conventions.md](reference_test_conventions.md) — Standing vitest conventions: Result assertions, branded VOs, temp dirs, the named-import mock seam, recurring gotchas
- [model-catalog-refresh-2026-07-26.md](model-catalog-refresh-2026-07-26.md) — Catalog/ladder bumps break "top of ladder" fixtures far outside the catalog files; run the FULL suite
- [fingerprint-audit-gate-pattern.md](fingerprint-audit-gate-pattern.md) — Recompute escalation-map.test.ts's SHA-256 catalog fingerprints by running the test, never by hand
- [gen-eval-exit-mapping.md](gen-eval-exit-mapping.md) — finalize-gen-eval `mapExit` verdict/warning/blockedReason truth table
- [gen-eval-turn-step-order-fence.md](gen-eval-turn-step-order-fence.md) — gen-eval-loop.test.ts shape fence + crash attribution (InvalidStateError is recoverable)
- [plateau-detector-subordination.md](plateau-detector-subordination.md) — Entropy/diversity leaves can never fire in the composed gen-eval loop; where the mutual-exclusion fences live
- [launcher-hitl-distill-confirm.md](launcher-hitl-distill-confirm.md) — launchCloseSprint/launchReview HITL distill confirm-gate test patterns
- [parallel-implement-wave-ordering-lock.md](parallel-implement-wave-ordering-lock.md) — scheduleIntoWaves dependency fence + concurrent FsTaskRepository integrity tests
- [parallel-implement-realgit-e2e.md](parallel-implement-realgit-e2e.md) — Real-git parallel worktree e2e; the branch-leak bug fake GitRunners structurally cannot catch
- [full-stack-e2e-wiring.md](full-stack-e2e-wiring.md) — Full-stack e2e wiring: implement launcher bypasses app.deps.provider, TUI mount plumbing, sprint pre-setup
- [sprint-selection-redesign-tests.md](sprint-selection-redesign-tests.md) — Reseat wiring, done-sprint filtering, MakeSpy intercept, fake-timer toast tests, ActionMenu cursor ordering
- [waitfor-loud-timeout-contract.md](waitfor-loud-timeout-contract.md) — ONE predicate waiter (`waitForPredicate`, throws on timeout) + the control-probe settle pattern
- [progress-overlay-flake-elimination.md](progress-overlay-flake-elimination.md) — SEEDED sentinel + waitFor pattern that eliminates flaky ink-testing-library overlay/scroll tests
