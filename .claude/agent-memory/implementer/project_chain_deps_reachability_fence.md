---
name: ChainSharedDeps reachability fence
description: ChainSharedDeps fields must be consumed by at least one chain file — adding a port without wiring it fails the architectural fence test
type: project
---

The architectural fence at `src/application/chains/__architecture__/chain-deps-reachability.test.ts` enforces that every `readonly` field declared on `ChainSharedDeps` is consumed by at least one chain file (matched via `deps.<field>` or `{ <field> } = deps` regex).

**Why:** Dead ports on `ChainSharedDeps` mislead the next contributor — they imply a chain uses something it doesn't, encouraging cargo-cult wiring. Better to land the port on `SharedDeps` first, then promote to `ChainSharedDeps` in the same PR that wires it into a leaf.

**How to apply:** When pre-staging a port for a multi-chunk refactor, only add it to `SharedDeps` (composition root) in the infrastructure chunk. Wire it into `ChainSharedDeps` in the chunk that adds the leaf consuming it. Don't try to satisfy the fence with a synthetic reference — that defeats the fence's purpose.
