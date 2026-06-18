# Implementer Memory

- [project_eventbus_branch_listener_leak.md](project_eventbus_branch_listener_leak.md) — long-session OOM root cause:
  uncapped EventBus + discarded parallel-branch unsubs + retained terminal SessionRecord runner ctx; the 5 fix seams
- [project_chain_runner_containment_boundary.md](project_chain_runner_containment_boundary.md) — createRunner.run()
  try/catch is the ONLY containment for non-DomainError throws from element.execute; raw AbortError must keep abort path
- [project_ledger_compaction_dedup_asymmetry.md](project_ledger_compaction_dedup_asymmetry.md) — bounded ledger
  (fix/oom-hardening): stream-ledger + compact-ledger; rewrite-side last-promoted-wins vs load-side first-wins (both OK);
  raw-line winners, tombstones never evicted, direct node:fs reads + WriteFile port
- [project_ledger_unknown_field_preservation.md](project_ledger_unknown_field_preservation.md) — stamp-promoted must keep
  non-stamped learnings.ndjson rows byte-for-byte (raw line); z.object strips future fields; don't switch to looseObject
- [project_shared_rate_limit_retry_seam.md](project_shared_rate_limit_retry_seam.md) — one shared retry loop
  (run-with-rate-limit-retry.ts) for all 3 headless adapters: owns backoff/banners/abort/session-resume/cold-fallback;
  stdoutTail rate-limit detection; idleWatchdogMs harness knob wiring checklist
- [feedback_concurrent_agent_writes.md](feedback_concurrent_agent_writes.md) — parallel agents stomp shared files;
  re-git-status before staging; recovery via git fsck unreachable blobs
- [project_nested_runner_subchain_adapter.md](project_nested_runner_subchain_adapter.md) — compose a self-contained
  sub-chain into multiple host flows via a nested-runner adapter element (NOT a 6th chain primitive)
- [project_task_field_names_vs_plan.md](project_task_field_names_vs_plan.md) — Task entity uses name/dependsOn, NOT
  title/blockedBy; map plan-doc terms to the entity field names
- [project_wave_scheduler_above_chain.md](project_wave_scheduler_above_chain.md) — runWaves is an above-the-chain
  orchestrator (not an Element) driving N per-branch createRunner instances; first real ALS fan-out consumer
- [project_clipboard_yank_pattern.md](project_clipboard_yank_pattern.md) — global `y` hotkey + clipboard adapter; uses
  ref-based ActiveTaskSummaryProvider on UiState to avoid re-rendering every consumer
- [project_global_modal_overlay_pattern.md](project_global_modal_overlay_pattern.md) — per-view inline vs
  App-Layout-level overlay modal; Layout-level wins for sprint-scoped overlays (~3 files vs 15)
- [project_display_clip_markers.md](project_display_clip_markers.md) — audit-[03] display-clip marker tokens (`…` /
  `▼ more`); truncate at display boundary, never at persistence
- [project_implement_role_meta_sidecar.md](project_implement_role_meta_sidecar.md) — stamp-role-meta leaves persist
  per-round AI attribution to rounds/<N>/<role>/meta.json; preStampedRoundNum ctx seam isolates round claiming
- [project_recoverable_turn_error_policy.md](project_recoverable_turn_error_policy.md) — gen-eval turn errors block the
  task (self-blocked exit) instead of aborting the run; Aborted/RateLimit still propagate; via isRecoverableTurnError
- [project_provider_stream_session_fields.md](project_provider_stream_session_fields.md) — empirical session-id/usage
  JSONL field names: codex thread_id on thread.started; copilot sessionId on result record
- [project_session_als_fenced_from_integration.md](project_session_als_fenced_from_integration.md) — currentSessionId()
  ALS helper in application/ is lint-fenced from integration; relocate to business/ before any adapter can read it
- [project_view_hint_single_source.md](project_view_hint_single_source.md) — TUI hints gate via useViewHints enabledWhen;
  inline body-footer hint prose is a duplicate ungated source — remove it when gating a key
- [project_per_attempt_round_display.md](project_per_attempt_round_display.md) — live round counter folds monotonic global
  round into per-attempt coords via perAttemptRound (render-time, not on bucket); genEvalMaxAttempts cap now fully wired
- [project_tui_commit_storm_coalescer.md](project_tui_commit_storm_coalescer.md) — consumer-side CoalescedBuffer decouples
  event-arrival from React-commit rate; fix for DEBUG-floor commit-storm OOM; + status-diff guard on useSessions/useSession
- [project_escalation_gate_broadened.md](project_escalation_gate_broadened.md) — finalize-gen-eval now escalates on
  plateau+budget-exhausted+malformed (not just plateau); malformed = same-model retry no ladder rung; fallbackMaxAttempts wired
- [project_attempt_scoped_ctx_reset_seam.md](project_attempt_scoped_ctx_reset_seam.md) — implement attempt-scoped ctx
  resets split across start-attempt (entry: verdict/session) vs progress-journal (exit: GENERATOR_HINTS accumulators)
- [project_structured_verify_gates.md](project_structured_verify_gates.md) — WS3 per-module verify gates: precedence,
  multi-gate VerifyRun representation, gitDiffFootprint seam, fail-fast post / all-run pre asymmetry, run-ALL fallback
- [project_detect_scripts_verify_gates_signal.md](project_detect_scripts_verify_gates_signal.md) — T9 verify-gates signal:
  ONE signal carrying gates[] (not per-gate), .nonempty() schema, additive to verify-script, needed RepositoryUpdate wiring
- [project_run_scoped_ctx_marker_fences.md](project_run_scoped_ctx_marker_fences.md) — a run-scoped ImplementCtx field
  needs 3 merge-wave fence updates (\_exhaustive map + mergeImplementWave + forkCtx); T13 fresh-setup-skip marker
- [project_generator_feedforward_seams.md](project_generator_feedforward_seams.md) — two generator-prompt feed-forward
  injections: cross-sprint prior-learnings ({{PRIOR_LEARNINGS}}, run-scoped ctx) + per-attempt dimension-trajectory
  (rides PRIOR_CRITIQUE_SECTION, no new placeholder); both pure ctx reads in the input projection
