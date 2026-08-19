---
name: reference-provider-fanout-registries
description: Widening the AiProvider union breaks ~15 total Record<AiProvider,…> tables plus one exhaustive switch — regenerate the list mechanically, never hand-maintain it
metadata:
  type: reference
---

Provider fan-out is registry-shaped, not switch-shaped. `docs/adding-a-provider.md` and root
`ARCHITECTURE.md` both describe "the compiler routes you to every place that must change" — the
places are total `Record<AiProvider, …>` tables, and the list rots the moment anyone adds one.

Regenerate rather than trust the doc:

```bash
grep -rn 'Record<AiProvider' src | grep -v Partial   # the total tables (compile errors)
grep -rn 'Partial<Record<AiProvider' src             # graceful-degradation registries (NOT errors)
```

The only remaining exhaustive `switch` on `AiProvider` is `toolForProvider`
(`src/integration/ai/readiness/_engine/tool.ts`). Widening `AssistantTool` additionally forces its
inverse `providerForTool` (same file) and `pickExistingContextPath`
(`src/application/flows/readiness/leaves/propose.ts`).

Gotcha: `PROVIDER_BINARY` / `PROVIDER_INSTALL_GUIDANCE` in `integration/system/detect-cli.ts` are
one-line projections OF `PROVIDER_TRAITS`, but each is still its own total record — they do break
the build. Two separate `PROVIDER_LABEL` tables exist (`flows/doctor/probe-helpers.ts` and
`ui/shared/launch/readiness.ts`); documenting only one is the easy miss.

Also drifts in pairs with provider counts: root `ARCHITECTURE.md § The provider boundary`,
`README.md` headline/badges, `docs/adding-a-provider.md` union + `z.enum` examples. See
[[project_high_drift_areas]].
