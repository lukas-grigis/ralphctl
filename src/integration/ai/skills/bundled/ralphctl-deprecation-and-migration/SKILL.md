---
name: ralphctl-deprecation-and-migration
description: Discipline for removing or replacing code, interfaces, stored data shapes, and dependencies safely — confirm the replacement covers every consumer, migrate consumers incrementally behind an adapter or switch, change persisted data in additive expand-then-contract phases with a tested way back, and remove the old path only once nothing uses it. Use when retiring an API, module, feature, flag, or dependency, renaming or dropping a stored field, or moving callers from one implementation to another.
license: MIT
---

# Deprecation and Migration

> Adapted from [addyosmani/agent-skills — "Deprecation and Migration"](https://github.com/addyosmani/agent-skills)
> (MIT). Adapted for ralphctl's harness contract.

Code is a liability, not an asset: every line needs tests, upgrades, and attention from anyone working
nearby. Deprecation removes code that no longer earns its keep; migration moves its consumers safely to
what replaces it. Most teams are good at adding things and bad at removing them — this skill is the
removal half.

## When this applies

- **Plan** — sequence the work so each step ships on its own: the replacement first, consumers next,
  removal last and alone. Give the removal task the verification criterion "no remaining consumers", and
  keep each data-shape phase below a separate task.
- **Execute** — implement one phase per task. Do not fold an additive step and its destructive follow-up
  into one change, and do not remove anything a consumer still reaches.

## Before removing anything

Hyrum's law makes removal hard: consumers depend on behaviour the replacement may not reproduce —
ordering, defaults, error text, side effects. Answer first:

1. Does the old thing still provide something nothing else does? If so, keep it.
2. Who consumes it? Search code, configuration, scripts, docs, and tests, including dynamic lookups by
   name. Consumers outside this repository may exist — say so rather than assume none.
3. Does a replacement exist and cover every critical use? If not, build that first.
4. What does each consumer's move cost, against the ongoing cost of keeping both?

## The process

1. **Replacement first.** It covers the critical cases and is proven, not just "theoretically better".
2. **Mark the old path deprecated** with the project's own mechanism — a deprecation annotation, a
   runtime warning, a changelog entry — when it has one. Do not invent a new notice file.
3. **Migrate incrementally.** One consumer or area per change: find its touchpoints, switch it, confirm
   behaviour matches with its tests, remove its reference to the old path. Whoever retires a thing
   migrates its consumers or ships a compatible shim — never leave them to discover the break.
4. **Remove only at zero.** Once no consumer remains: the code, its tests, docs, configuration, and the
   deprecation markers themselves.

## Migration patterns

- **Strangler** — run old and new side by side and route a growing share to the new path; remove the old
  one when its share is zero.
- **Adapter** — keep the old interface as a thin layer over the new implementation, so consumers keep
  working while the backend moves.
- **Switch per consumer** — cut consumers over one at a time with the project's existing flag or
  configuration mechanism.

## Persisted data: expand, then contract

A stored shape is the riskiest thing to change — reverting the code does not revert the data, and during a
rollout old and new code run against the same store. Never change a stored shape in place:

```
EXPAND            →  MIGRATE                         →  CONTRACT
add the new shape    write both, backfill old records,  stop writing the old shape,
beside the old one   then switch reads to the new one   then drop it in a later change
```

- Additive first, destructive last and alone. Adds are safe in any release; drops and renames ship on
  their own, after nothing reads the old shape.
- Every migration has a tested way back — a down migration, or readers that tolerate both shapes.
- A migration is safe to re-run and safe to interrupt; stamp what has been migrated.
- Backfill in batches, off the hot path, so it does not lock or starve the store.
- The same rules hold for files on disk: version the format, and keep readers tolerant of the old shape.

## Zombie code

Code nobody owns but something still depends on — no maintainer, failing tests nobody fixes, outdated
dependencies. Either give it an owner and maintain it, or deprecate it with a concrete migration. It
cannot stay in limbo.

## Common rationalisations

| Rationalisation                                   | Reality                                                                                   |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| "It still works, why remove it?"                  | Unmaintained working code accumulates risk and complexity silently.                       |
| "Someone might need it later"                     | It can be rebuilt if needed. Keeping it "just in case" costs more.                        |
| "Consumers will migrate on their own"             | They will not. Migrate them, or ship a shim that needs no migration.                      |
| "Just rename the field, it's one line"            | During rollout, old and new code run together and one of them reads a field that is gone. |
| "Add the new field and drop the old one together" | That couples a safe add to a destructive drop. Drops ship alone, later.                   |
| "We'll write the way back if we need it"          | A migration with no way back is a release you cannot undo.                                |

## Red flags

- A deprecation with no working replacement.
- Removal without a search for remaining consumers.
- New features added to the deprecated path.
- A stored field renamed or dropped in place.
- A schema change and the code that depends on it shipped as one step.
- A migration with no way back, or a backfill that locks the store.

## Self-check

- [ ] The replacement covers every critical use of the old path.
- [ ] Every known consumer is migrated; unknown external consumers are named as a risk.
- [ ] Persisted-shape changes are phased: expand, migrate, contract.
- [ ] Each migration has a tested way back and is safe to re-run.
- [ ] Removal deletes the code, its tests, docs, configuration, and deprecation markers.
