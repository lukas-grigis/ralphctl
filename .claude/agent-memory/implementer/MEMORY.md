# Implementer Memory

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
