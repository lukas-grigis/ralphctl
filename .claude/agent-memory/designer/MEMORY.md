# Designer Memory

## TUI Architecture

- [project_home_pipeline_map.md](project_home_pipeline_map.md) — HomeView pipeline-map spine + tiered browse submenu
  design decisions (Apr 2026)
- [project_execute_view_terminal_state.md](project_execute_view_terminal_state.md) — Runner terminal status tracking
  pattern + next-step CTA (May 2026)

## Cross-Project Navigation

- [project_cross_project_sprint_picker.md](project_cross_project_sprint_picker.md) — `S` cross-project grouped picker:
  Option B chosen, `t` scope-toggle, atomic setProjectAndSprint required

## Execute View Rail Fix

- [project_execute_rail_fix.md](project_execute_rail_fix.md) — Responsive rail width + step-ID label separation: Option
  D hybrid, resolveRailWidth(), label field on Element/TraceEntry

## Modal Overlays

- [../implementer/project_global_modal_overlay_pattern.md](../implementer/project_global_modal_overlay_pattern.md) —
  Per-view inline vs App-Layout-level overlay — when to use each

## Multi-Flow Navigation

- [project_multi_flow_nav_design.md](project_multi_flow_nav_design.md) — Tab/Shift+Tab cycle + Ctrl+1..9 direct-jump: decisions on location, gating, router.replace vs push, Ctrl+digit terminal risk (Jun 2026)

## Windowed List Navigation

- [project_unified_windowed_list.md](project_unified_windowed_list.md) — useListWindow hook + WindowedList component: full convergence design, ScrollRegion suppressArrows, adoption plan for all 6 list views (Jun 2026)

## Flow Registry

- [project_ticket_add_flow_consolidation.md](project_ticket_add_flow_consolidation.md) — ticket-add removed from registry; add-tickets is sole Flows menu entry; `a` shortcut stays on add-ticket wizard (Jun 2026)

## Picker & Customize Flow

- [project_picker_effort_inheritance.md](project_picker_effort_inheritance.md) — T14 effort-inheritance fix: model-only change shows concrete inherited effort + source tag in keep-default label (Jun 2026)

## Settings Harness Section

- [project_harness_settings_section.md](project_harness_settings_section.md) — T15 harness section: escalateOnPlateau/skipPreVerifyOnFreshSetup as select fields; readonly-map kind for escalationMap (Jun 2026)

## Status Card Patterns

- [feedback_baseline_card_row_pattern.md](feedback_baseline_card_row_pattern.md) — One row pattern for status cards:
  status always on sub-line; compact all-clean variant as single string; title accent rules

## Implement View Height Budget

- [project_implement_view_height_budget.md](project_implement_view_height_budget.md) — Sidebar height-budget model: shared sidebarBodyRows formula, suppressMeta for narrow rails, label+space pattern (Jun 2026)

## Implement View Band Layout

- [project_implement_view_band_layout.md](project_implement_view_band_layout.md) — Status band + nav sidebar: component tree, where meta lives, height budget, token honesty rules (Jun 2026)

## Implement Header + Sidebar Layout

- [project_implement_header_effort_sidebyside.md](project_implement_header_effort_sidebyside.md) — HeaderCard two-line gen/eval model+effort; side-by-side Baseline+Token at ≥xl (sidebarContextSideBySide); threading chain (Jun 2026)
