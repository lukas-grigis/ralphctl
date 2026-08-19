# Memory Index

## Subsystem seams

- [seams_escalation_ladder.md](seams_escalation_ladder.md) — Which exits consult the policy, the provider/model-aware effort rung and its wiring, and where AbortCause can be stamped
- [seams_plateau_and_turn_errors.md](seams_plateau_and_turn_errors.md) — Count-based plateau predicate and exemptions, budget precedence over the in-loop guards, which turn errors block vs propagate
- [seams_attempt_ctx_and_telemetry.md](seams_attempt_ctx_and_telemetry.md) — Per-attempt ctx lifecycle: reset sites, the ctx-field classification guard, cost telemetry, round numbering, round display
- [seams_prompt_feedforward.md](seams_prompt_feedforward.md) — Criteria history, dimension trajectory, prior learnings: where each is composed and which prompt it rides
- [seams_memory_ledger_and_mutex.md](seams_memory_ledger_and_mutex.md) — Raw-line preservation, the correct dedup asymmetry, the three shared-file mutexes, the RMW-race test pattern
- [seams_verify_gates.md](seams_verify_gates.md) — Per-module verify gates: precedence, multi-gate representation, diff-footprint scoping + coverage flag, fresh-setup skip, detect-scripts emission
- [seams_provider_engine_streaming.md](seams_provider_engine_streaming.md) — One shared rate-limit retry loop, empirical stream field names, stdout OOM caps, kill escalation
- [seams_provider_conformance_and_demo.md](seams_provider_conformance_and_demo.md) — The src-side scripted-spawn builder shared by conformance suites and `demo --script`; buildEnv / effortForwarding contracts
- [seams_chain_runner_core.md](seams_chain_runner_core.md) — createRunner as the only containment boundary, the aborted-with-error contract, the five listener-leak seams
- [seams_parallel_runner_architecture.md](seams_parallel_runner_architecture.md) — runWaves above the chain, the nested-runner sub-chain adapter, rootSessionId vs currentSessionId, the ALS import fence
- [seams_tui_architecture_patterns.md](seams_tui_architecture_patterns.md) — Modal overlays, global hotkeys over view-local data, clip markers, one hint source, the commit-storm coalescer, cancel-vs-abort
- [seams_tui_test_gotchas.md](seams_tui_test_gotchas.md) — Test setups that pass for the wrong reason: batched stdin, the 100x24 stub, spinner flap, vacuous scroll tests, traversal-sandbox poisoning
- [seams_model_catalog_refresh.md](seams_model_catalog_refresh.md) — Catalog-refresh checklist: fingerprint gate, where the retired-model remap is tested, prose restatement, the settings.ts lint hazard

## Standalone

- [project_release_gate_seams.md](project_release_gate_seams.md) — Release/CI seams: color pin, npm-pack prefix trap, CLI error frame, prompts-list gate, pre-release tag/dist-tag pairing
- [project_settings_default_flip_surfaces.md](project_settings_default_flip_surfaces.md) — Every surface that restates a `settings.harness` default, plus the preset-pin seam
- [project_slugged_data_layout_resolver.md](project_slugged_data_layout_resolver.md) — The slugged on-disk data layout and its tolerant resolvers
- [project_migration_consent_gate_wiring.md](project_migration_consent_gate_wiring.md) — The data-migration consent splash + backup gate and how it is wired
- [project_skill_selection_resolution_seam.md](project_skill_selection_resolution_seam.md) — Skill selection → `createResolvedSkillSource` resolution path
- [project_flows_view_soft_repo_default.md](project_flows_view_soft_repo_default.md) — Flows-view repo selection and its soft default
- [project_task_field_names_vs_plan.md](project_task_field_names_vs_plan.md) — `Task.name`/`dependsOn` vs the plan doc's "title"/"blockedBy" — a recurring naming mismatch
- [project_trustworthy_firstrun_waves12_2026-08-14.md](project_trustworthy_firstrun_waves12_2026-08-14.md) — Honest doctor probes, the useViewKeys Escape gotcha, the demo seeder
- [feedback_concurrent_agent_writes.md](feedback_concurrent_agent_writes.md) — Recovery procedure when parallel agents collide on the same files
