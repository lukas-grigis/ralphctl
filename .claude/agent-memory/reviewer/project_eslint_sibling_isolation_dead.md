---
name: eslint-sibling-isolation-dead-under-integration
description: 'RESOLVED 2026-08-01: dead fences fixed via mergeRestrictedImports composition — durable lesson: flat config replaces same-key rule entries, so overlapping blocks must carry the union'
metadata:
  type: project
---

RESOLVED: the dead fences were fixed the same day via `mergeRestrictedImports` in
`eslint.config.ts` — every sibling-isolation block now composes its layer base back in
(integration spawn-fenced rule / businessLayerRule / domainLayerRule / chainsLayerRule), and the
five `integration/ai` sibling blocks moved after the general `src/integration/**` blocks so they
win. Empirical probing found the blast radius was WIDER than first recorded: besides the five ai
sibling isolations, the business I/O + composite-repository bans, the domain layer rule under
`repository/<x>/`, and the chains no-concrete-adapters rule under `flows/<x>/` were all dead.
Resurrecting the chains rule exposed 42 per-signal schema imports — all in per-leaf
`*.contract.ts` files, which the audit-[09] contract sanctions, so the rule (not the code) was
adjusted: `chainsContractFileRule` lifts only the schema ban for `*.contract.ts`.

**Durable lesson (still true):** ESLint flat config REPLACES a same-key rule entry when a later
block matches the same file — options never merge. Any block narrowing a broader glob silently
wipes the broader block's same-key restrictions in both directions. The liveness suite in
`tests/unit/eslint-config.test.ts` ("fence liveness under overlapping config blocks") probes
every overlap with `Linter().verify`; extend it whenever a new no-restricted-imports block
lands, and verify a "fence exists" claim by probe, not by reading the config.

Related: [[project_duplicate_codex_effort_clamp]] for the same "a fence exists but doesn't
fire" failure mode.
