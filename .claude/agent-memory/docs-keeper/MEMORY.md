# Memory Index

- [feedback_chain_traces_drift_fast.md](feedback_chain_traces_drift_fast.md) — Execute / Per-task / Feedback / Onboard
  step traces drift most often; check tests first
- [reference_step_trace_locations.md](reference_step_trace_locations.md) — Where step traces live in the docs (three
  locations per chain)
- [reference_agent_files_also_drift.md](reference_agent_files_also_drift.md) — .claude/agents/\*.md +
  .claude/docs/README.md also list kernel primitives; grep them when primitives change
- [project_high_drift_areas.md](project_high_drift_areas.md) — Top 10 doc sections that go stale fastest; check these
  first after any feature drop
- [reference_harness_principles_doc.md](reference_harness_principles_doc.md) — HARNESS-PRINCIPLES.md: 18 rows,
  applied/partial/gap; update when chain/flow/\_engine changes close a gap
- [project_changelog_unreleased_drafting.md](project_changelog_unreleased_drafting.md) — [Unreleased] drafting must
  diff both `<tag>..origin/main` and `origin/main..HEAD` — squash-merged PRs can lack a changelog line
- [reference_opencode_headless_vs_interactive.md](reference_opencode_headless_vs_interactive.md) — SECURITY.md's
  OpenCode paragraphs mix headless (`--auto`) and interactive (`buildOpencodeEnv` config grant) — don't conflate
- [reference_provider_fanout_registries.md](reference_provider_fanout_registries.md) — Provider fan-out is
  `Record<AiProvider,…>` tables, not switches; regenerate the list by grep, never hand-maintain
- [reference_mermaid_validation_entities.md](reference_mermaid_validation_entities.md) — `&lt;`/`&gt;` entities
  inside mermaid blocks are a REAL parse error (GitHub included) — use raw `<angle brackets>`; 01-flow-lifecycle.md still broken
- [reference_entity_symbol_names_drift.md](reference_entity_symbol_names_drift.md) — ARCHITECTURE § Data Models
  entity mutator/field names rot silently; table of the 2026-08-18 renames
