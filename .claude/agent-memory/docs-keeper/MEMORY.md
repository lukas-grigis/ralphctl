# Memory Index

- [reference_step_trace_locations.md](reference_step_trace_locations.md) — Where step traces live (real headings), source-of-truth tests, the plan-chain exception; procedure is the flow-trace-sync skill
- [project_high_drift_areas.md](project_high_drift_areas.md) — The doc hot zones that re-rot every sprint, and what to regenerate each from
- [project_changelog_unreleased_drafting.md](project_changelog_unreleased_drafting.md) — Pointer to changelog-draft plus its blind spot: squash-merged PRs lacking a changelog line
- [reference_agent_files_also_drift.md](reference_agent_files_also_drift.md) — `.claude/agents/*.md` and `.claude/docs/README.md` restate kernel primitives; grep them too
- [reference_entity_symbol_names_drift.md](reference_entity_symbol_names_drift.md) — ARCHITECTURE § Data Models symbol names rot silently; grep each one
- [reference_harness_principles_doc.md](reference_harness_principles_doc.md) — HARNESS-PRINCIPLES.md status tags; re-evaluate on any chain/flow/_engine change
- [reference_mermaid_validation_entities.md](reference_mermaid_validation_entities.md) — `&lt;`/`&gt;` in a mermaid block is a parse error; validate with `mermaid.parse()`
- [reference_opencode_headless_vs_interactive.md](reference_opencode_headless_vs_interactive.md) — OpenCode's two directory-grant mechanisms must never be conflated
- [reference_provider_fanout_registries.md](reference_provider_fanout_registries.md) — Provider fan-out is `Record<AiProvider,…>` tables, not switches; regenerate the list by grep
- [reference_restore_quarantine_doc_homes.md](reference_restore_quarantine_doc_homes.md) — Blocked-diff restore/quarantine doc homes that must move together; read the actual conditional
- [feedback_no_linebreak_inside_codespan.md](feedback_no_linebreak_inside_codespan.md) — Keep inline code spans on one line in doc bullets
