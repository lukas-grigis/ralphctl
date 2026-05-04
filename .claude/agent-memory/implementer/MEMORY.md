# Implementer Memory

- [feedback_src_next_chain_pattern.md](feedback_src_next_chain_pattern.md) — chain pattern in src/ workflow
- [project_chain_deps_reachability_fence.md](project_chain_deps_reachability_fence.md) — every ChainSharedDeps field must be consumed by a chain file or the fence test fails
- [project_session_md_audit.md](project_session_md_audit.md) — per-spawn session.md audit pack is written by the AI session adapter (not chain leaves) when SessionOptions.sessionMdPath is set
