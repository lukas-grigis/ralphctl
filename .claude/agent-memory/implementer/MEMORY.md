# Implementer Memory

- [project_root_session_id_nested_runners.md](project_root_session_id_nested_runners.md) — nested runners shadow
  currentSessionId(): TUI-keyed chainSessionId must use the new rootSessionId(); + router.reset(entry) is now
  required, and guard's single body-named `skipped` entry is what marks a dependency-blocked task

- [project_runner_aborted_event_error_seam.md](project_runner_aborted_event_error_seam.md) — RunnerEvent
  'aborted' carries an error ONLY for in-chain aborts (never for caller abort()/sibling kill); wave-scheduler
  captures it on BOTH failed+aborted to stop the schedule instead of launching later waves

- [project_settings_default_flip_surfaces.md](project_settings_default_flip_surfaces.md) — flipping a
  settings.harness default: 6 untested prose restatements (settings.ts JSDoc, TUI HARNESS_HINTS, 5 docs) +
  the optional per-preset harness pin seam in applyPreset
- [project_external_kill_escalation_seam.md](project_external_kill_escalation_seam.md) — killWithEscalation shared
  SIGTERM→grace→SIGKILL helper for io runners (separate copy of provider-engine ladder, sibling-isolation); interactive
  adapters' abortSignal was dead code, now threaded from 4 leaves + classified before exit-code; sonarjs 3-literal ratchet gotcha
- [project_prompt_queue_cancel_vs_abort.md](project_prompt_queue_cancel_vs_abort.md) — TUI prompt-queue esc-cancel
  & shutdown reject with PLAIN Error (never AbortError), so a blanket `.catch` around prompt promises can safely
  re-throw AbortError; edit text-prompt seam (use-edit-field) vs field-picker seam (field-editors) are independent
- [project_slugged_data_layout_resolver.md](project_slugged_data_layout_resolver.md) — human-readable `<id>--<slug>`
  data/ layout: one tolerant id-prefix resolver in storage.ts; direct-build (entity-in-hand) vs resolver (id-only);
  reconcile-on-save (project write-then-delete, sprint rename-then-write); projectSlug threaded for memory ledger;
  uuid7 monotonic counter; PATH-gate-before-resolver fail-fast gotcha
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
  task (self-blocked exit) instead of aborting the run; Aborted/RateLimit propagate; ProcessCrash → crashed retry (both roles)
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
- [project_effort_escalation_rung_seam.md](project_effort_escalation_rung_seam.md) — same-model effort rung (default→high)
  between model-jump and nudge in decideEscalation; nextEffortRung helper; ACTIVATED end-to-end 2026-07-02 via
  escalatedToEffort task field + per-task-subchain→finalize-leaf wiring (launch is UI-fenced) + generator.ts read
- [project_criteria_history_feedforward_seam.md](project_criteria_history_feedforward_seam.md) — composeCriteriaHistory
  (business) renders Task.criteriaVerdicts k/N into BOTH implement+evaluate prompts; derived INSIDE the prompt builders
  from input.task (not threaded via leaves); optional placeholder; evaluate template adds re-verify framing
- [project_attempt_scoped_ctx_reset_seam.md](project_attempt_scoped_ctx_reset_seam.md) — implement attempt-scoped ctx
  resets split across start-attempt (entry: verdict/session) vs progress-journal (exit: GENERATOR_HINTS accumulators)
- [project_structured_verify_gates.md](project_structured_verify_gates.md) — WS3 per-module verify gates: precedence,
  multi-gate VerifyRun, gitDiffFootprint seam, fail-fast post / all-run pre asymmetry, coveredAllGates carry flag
- [project_detect_scripts_verify_gates_signal.md](project_detect_scripts_verify_gates_signal.md) — T9 verify-gates signal:
  ONE signal carrying gates[] (not per-gate), .nonempty() schema, additive to verify-script, needed RepositoryUpdate wiring
- [project_run_scoped_ctx_marker_fences.md](project_run_scoped_ctx_marker_fences.md) — a run-scoped ImplementCtx field
  needs 3 merge-wave fence updates (\_exhaustive map + mergeImplementWave + forkCtx); T13 fresh-setup-skip marker
- [project_generator_feedforward_seams.md](project_generator_feedforward_seams.md) — two generator-prompt feed-forward
  injections: cross-sprint prior-learnings ({{PRIOR_LEARNINGS}}, run-scoped ctx) + per-attempt dimension-trajectory
  (rides PRIOR_CRITIQUE_SECTION, no new placeholder); both pure ctx reads in the input projection
- [project_migration_consent_gate_wiring.md](project_migration_consent_gate_wiring.md) — Wave 2b TTY migration consent
  gate: MigrationGate pre-app Ink route (props not context), launch.ts shouldShowMigrationGate seam + closure-flag
  resolve, renderLearnings adapter in app/UI layer, failure-screen downgrade fallback, CLI skips migration entirely
- [project_flows_view_soft_repo_default.md](project_flows_view_soft_repo_default.md) — flows-view launch handler runs a
  dedicated repo-selection step (flows-repository-picker.ts) BEFORE the customize picker; sessionRepositoryId is a
  re-pickable soft default not a hard lock; gate on explicit 3-flow allowlist (detect-scripts/detect-skills/readiness)
- [project_loop_diversity_budget_precedence.md](project_loop_diversity_budget_precedence.md) — gen-eval loop-diversity
  guard must not pre-empt the final budgeted turn; budget-exhausted wins over plateau when turnsUsed >= maxTurns (reads
  readConfig budget, not a captured const)
- [project_skill_selection_resolution_seam.md](project_skill_selection_resolution_seam.md) — #216 T4: ONE skill
  resolution point (createResolvedSkillSource decorator in launcher buildComposedSkillSource); compose order
  bundled→project→operator→phase (LAST-wins dedupe), disabled subtraction, getByName unfiltered, aiFlowIdFor aliasing
- [project_plateau_predicate_count_based.md](project_plateau_predicate_count_based.md) — plateau predicate is
  failed-dim-COUNT based (not identical-set); critique-shift (Jaccard<0.5) is the lever to keep a multi-turn loop test
  running; R2 entropy guard reads ctx.lastTurnActionCounts (signal-kind proxy) stamped by generator every turn
- [project_attempt_cost_telemetry_seam.md](project_attempt_cost_telemetry_seam.md) — per-attempt token/duration
  persistence pipeline: ProviderOutput.usage → RoleTurnOutcome → ctx SIGNAL_ACCUM accumulators (CARRY, because
  settle reads them before progress-journal clears) → settle → recordAttemptUsage; absent ≠ 0
- [project_provider_port_conformance_seam.md](project_provider_port_conformance_seam.md) — scripted-spawn
  builder lives in src/\_engine (demo bundles it, tests only compose it); buildEnv(input, context)→Result fixed
  the #278 root drop; effortForwarding is per-SURFACE; eslint-disable must be the LAST comment line
- [project_provider_literal_duplication_lint_cap.md](project_provider_literal_duplication_lint_cap.md) — a new
  provider-keyed table in settings.ts (raw 'github-copilot'/'openai-codex' literals) can tip sonarjs/no-duplicate-string
  and blow the ratcheted lint cap; hoist PROVIDER_GITHUB_COPILOT/PROVIDER_OPENAI_CODEX like PROVIDER_CLAUDE_CODE
- [project_trustworthy_firstrun_waves12_2026-08-14.md](project_trustworthy_firstrun_waves12_2026-08-14.md) —
  doctor 'unknown' status + per-provider auth probe table; useViewKeys CANNOT match Escape/arrows/fn-keys via
  its `keys` array (Ink collapses their `input` to `''`) — use a raw useInput + claimEscape() instead;
  seedDemoWorkspace shared by pnpm mock + ralphctl demo; RunCommand has no cwd (use `-C <dir>`); lint is
  --max-warnings 0 (fatal, not advisory)
- [project_demo_scripted_spawn_seam.md](project_demo_scripted_spawn_seam.md) — `ralphctl demo --script`:
  AppDeps.providerSpawn must be forwarded at BOTH launcher rebuild sites (implement bypasses
  buildLaunchAdapters); scripted beats dispatch off the rounds/<N>/<role>/signals.json path scraped from
  the prompt — anchor the regex on the whole tail or it locks onto the template's `<outputDir>` prose
- [project_path_traversal_test_sandbox.md](project_path_traversal_test_sandbox.md) — test-first traversal
  regressions really escape the tmp fixture; nest session under a per-run root so the asserted escape
  target stays unique, or the pre-fix artifact poisons the post-fix assertion
- [project_tui_row_windowing_and_key_test_gotchas.md](project_tui_row_windowing_and_key_test_gotchas.md) — row-count
  windowing needs 1 entry == 1 terminal row (pre-wrap, not truncate-end); ink-testing stdin batches a whole
  written string into ONE useInput call; stub terminal is 100x24
- [project_release_gate_seams.md](project_release_gate_seams.md) — release/CI gates: vitest FORCE_COLOR pin (never
  add NO_COLOR), `npm init -y --prefix` writes into CWD (nearly corrupted package.json pre-publish), runCli's
  reportFatal terminal frame (AbortError handled not re-thrown), `prompts list` as the prompt-resolver dist gate
