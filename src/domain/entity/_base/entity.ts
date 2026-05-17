/**
 * Root contract for domain entities — every aggregate has a stable, immutable identity.
 * Inspired by clean-spring-core's `SimpleEntity<I>`; collapsed to a single interface here
 * because:
 *
 *   - TypeScript doesn't need a separate "marker" parent like Java's `Entity`.
 *   - Audit metadata (version / createdAt / updatedAt) isn't used in this codebase, so the
 *     two-tier `SimpleEntity` / `StandardEntity` split would add complexity without payoff.
 *
 * `id` is a branded value (e.g. `ProjectId`), so the type system already prevents passing the
 * wrong id type to a function expecting another aggregate's identity. No constraint on `I`.
 */
export interface Entity<I> {
  readonly id: I;
}
