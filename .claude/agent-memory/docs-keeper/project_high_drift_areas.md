---
name: project-high-drift-areas
description: The doc hot zones that go stale fastest — check these first on any audit, before reading git log
metadata:
  type: project
---

Repeat offenders across every audit pass. These are hot zones, not open defects — the specific
instances found through 2026-08-18 are all fixed; the _sections_ keep re-rotting.

| Hot zone                                                     | Regenerate it from                                                                                    |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Any doc listing the `AppEvent` union                         | grep `events.ts` — new events land in commits that don't announce themselves                          |
| KERNEL-DESIGN.md chain examples + `Element`/`TraceEntry`     | diff against `element.ts` + `trace.ts`; interface field additions need both the code block and prose  |
| Chain step traces (all docs)                                 | the flow's e2e test — see [[reference_step_trace_locations]] and [[feedback_chain_traces_drift_fast]] |
| ARCHITECTURE.md § Composition Root / Storage layout          | grep the `StoragePaths` type for new fields and new top-level dirs                                    |
| ARCHITECTURE.md § Data Models symbol names                   | grep each named symbol in `src/` — see [[reference_entity_symbol_names_drift]]                        |
| ARCHITECTURE.md § Harness Signals table                      | signal rows lag flow changes; check which flow actually consumes each signal                          |
| ARCHITECTURE.md § Flows-and-their-nature table               | diff `registry.ts`                                                                                    |
| DESIGN-SYSTEM.md § component table + global keys             | deleted components linger after a TUI rename/delete sprint; new global keys go unlisted               |
| ARCHITECTURE.md § Future Work, REQUIREMENTS § deferred       | shipped items stay listed — cross-check both against the commit log every pass                        |
| REQUIREMENTS.md checkboxes                                   | `[x]` not ticked after the code shipped                                                               |
| PERFORMANCE.md § Escalation on plateau                       | the plateau-signal list grows whenever a guard is added                                               |
| Any doc stating parallelism/sequencing of the implement flow | re-read after ANY implement-flow structural change; these sentences invert silently                   |

**Why:** the churn clusters in three places — the observability/TUI surface, the chain framework
primitives, and the implement flow — and every sprint touches at least one.

**How to apply:** walk this table before reading git log. Express volatile numbers as named constants
or breakpoints in the prose rather than hardcoded values, so the doc degrades gracefully.
