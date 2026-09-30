---
name: reference-entity-symbol-names-drift
description: ARCHITECTURE § Data Models names entity mutators and fields that get renamed without a doc edit; grep every named symbol
metadata:
  type: reference
---

`ARCHITECTURE.md § Data Models` is where agents are pointed for entity shapes, and it accumulates symbol names that no
longer exist. Every name in it is a claim: `grep -rn "<symbol>" src` before repeating one.

Sections that repeat the same names and must be edited together: `WORKFLOWS.md § Two-phase planning` (ticket status and
repo selection) and `PERFORMANCE.md § learning ledger`.
