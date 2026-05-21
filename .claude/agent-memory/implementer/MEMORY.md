# Implementer Memory

- [feedback_src_next_chain_pattern.md](feedback_src_next_chain_pattern.md) — chain factory conventions under src/application/chains/: lean deps, pre-loaded data, integration-test step assertions
- [feedback_concurrent_agent_writes.md](feedback_concurrent_agent_writes.md) — parallel agents stomp shared files; re-git-status before staging; recovery via git fsck unreachable blobs
- [project_chain_deps_reachability_fence.md](project_chain_deps_reachability_fence.md) — every ChainSharedDeps field must be consumed by a chain file or the fence test fails
- [project_session_md_audit.md](project_session_md_audit.md) — per-spawn session.md audit pack is written by the AI session adapter (not chain leaves) when SessionOptions.sessionMdPath is set
- [project_clipboard_yank_pattern.md](project_clipboard_yank_pattern.md) — global `y` hotkey + clipboard adapter; uses ref-based ActiveTaskSummaryProvider on UiState to avoid re-rendering every consumer
- [project_global_modal_overlay_pattern.md](project_global_modal_overlay_pattern.md) — per-view inline vs App-Layout-level overlay modal; Layout-level wins for sprint-scoped overlays (~3 files vs 15)
