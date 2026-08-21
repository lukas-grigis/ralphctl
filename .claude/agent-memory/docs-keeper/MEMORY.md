# Memory Index

- [feedback_chain_traces_drift_fast.md](feedback_chain_traces_drift_fast.md) — Flow step traces are the fastest-drifting docs; read the flow's e2e test before editing
- [project_high_drift_areas.md](project_high_drift_areas.md) — The doc hot zones that re-rot every sprint, and what to regenerate each from
- [project_changelog_unreleased_drafting.md](project_changelog_unreleased_drafting.md) — [Unreleased] drafting needs both `<tag>..origin/main` and `origin/main..HEAD` — squash-merged PRs can lack a line
- [reference_step_trace_locations.md](reference_step_trace_locations.md) — The three doc locations per chain step trace, plus the plan-chain exception and the gen-eval fences
- [reference_agent_files_also_drift.md](reference_agent_files_also_drift.md) — `.claude/agents/*.md` and `.claude/docs/README.md` restate kernel primitives; grep them too
- [reference_entity_symbol_names_drift.md](reference_entity_symbol_names_drift.md) — ARCHITECTURE § Data Models entity mutator/field names rot silently; table of confirmed renames
- [reference_harness_principles_doc.md](reference_harness_principles_doc.md) — HARNESS-PRINCIPLES.md's 18 status-tagged rows; re-evaluate on any chain/flow/_engine change
- [reference_mermaid_validation_entities.md](reference_mermaid_validation_entities.md) — `&lt;`/`&gt;` in a mermaid block is a real parse error; use raw angle brackets and validate with `mermaid.parse()`
- [reference_opencode_headless_vs_interactive.md](reference_opencode_headless_vs_interactive.md) — OpenCode's two directory-grant mechanisms (`--auto` headless vs `buildOpencodeEnv` interactive) must never be conflated
- [reference_provider_fanout_registries.md](reference_provider_fanout_registries.md) — Provider fan-out is `Record<AiProvider,…>` tables, not switches; regenerate the list by grep
