/**
 * `createResolvedSkillSource` — the SINGLE skill-selection resolution seam. A {@link SkillSource}
 * decorator that turns a *composed* union of sources (bundled + project + operator + phase-folder)
 * into the effective per-flow set a launch actually installs:
 *
 *   getForFlow(flow) = dedupeByNameLastWins(inner.getForFlow(flow)) − flowDisabled(flow)
 *
 * Two steps, two jobs:
 *
 *  1. **dedupe by name, LAST occurrence wins.** The launcher composes the union in a fixed order —
 *     bundled, then project, then operator, then the phase folder LAST — precisely so a later
 *     source shadows an earlier one for the same install name. A phase-folder copy of
 *     `ralphctl-foo` therefore beats the bundled `ralphctl-foo`; the operator likewise beats
 *     bundled. When there are no duplicate names (the common case) this is a byte-for-byte no-op:
 *     the list and its order are preserved, which is what keeps the zero-config skill set identical
 *     to the pre-decorator behaviour.
 *
 *  2. **subtract the disabled name-set.** `flowDisabled(flow)` returns the names to remove for that
 *     flow — the launcher supplies the union of the durable `settings.ai.skills[flow].disabled`
 *     preference and the per-run `LaunchExtras.skillsOverride.disabled`. Subtraction is by exact
 *     install name, so it applies to ANY skill (bundled, project, operator, or phase-folder) — the
 *     opt-out is name-based, not source-based.
 *
 * `getByName` passes through UNFILTERED and un-deduped. Reason: `getByName` is a name-RESOLUTION
 * seam, not an install seam — the readiness flow's `offer-skill-suggestions` leaf uses it to decide
 * whether an AI-suggested name maps to a known bundled skill (install its canonical body) or is
 * unknown (scaffold a stub). Filtering it by the per-flow disabled set would mislabel a skill the
 * operator opted OUT of for auto-install as "unknown" and scaffold a wrong stub. Opt-out governs
 * what a flow AUTO-INSTALLS, never what a name resolves to.
 *
 * v2 seam: the subset computation is intentionally hidden behind this one decorator. A future
 * relevance recommender (rank + keep the most relevant N skills per flow) replaces the
 * `dedupe − disabled` body here — or swaps `flowDisabled` for a richer `select(flow, skills)` dep —
 * without changing the {@link SkillSource} contract or touching a single install-skills leaf /
 * adapter. This doc names that intent; no speculative hook is built for it today.
 */

import { Result } from '@src/domain/result.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Skill } from '@src/integration/ai/skills/_engine/skill.ts';
import type { SkillSource } from '@src/integration/ai/skills/_engine/skill-source.ts';
import type { FlowId } from '@src/integration/ai/skills/_engine/registry.ts';

/**
 * Deduplicate by install `name`, keeping the LAST occurrence at its LAST position. Implemented by
 * recording each name's final index then emitting only the entries that sit at that index, so
 * de-duplication never re-orders survivors: a list with no duplicate names comes back unchanged
 * (order and identity), which is the zero-config invariant the launcher relies on.
 */
const dedupeByNameLastWins = (skills: readonly Skill[]): readonly Skill[] => {
  const lastIndexByName = new Map<string, number>();
  skills.forEach((skill, index) => lastIndexByName.set(skill.name, index));
  return skills.filter((skill, index) => lastIndexByName.get(skill.name) === index);
};

/**
 * Factory input for {@link createResolvedSkillSource}.
 *
 * @public
 */
export interface ResolvedSkillSourceDeps {
  /** The composed union source (bundled + project + operator + phase folder, in that order). */
  readonly inner: SkillSource;
  /**
   * Names to SUBTRACT for a flow — the launcher supplies the union of the saved
   * `settings.ai.skills[flow].disabled` preference and the per-run `skillsOverride.disabled`.
   * Called per `getForFlow`; the launcher's closure is run-scoped so the returned set is the same
   * across a run. The `flowId` argument keeps the decorator generic (a v2 recommender can key on
   * it); duplicate names in the returned array are harmless — they collapse into a `Set`.
   */
  readonly flowDisabled: (flowId: FlowId) => readonly string[];
}

/**
 * Wrap a composed {@link SkillSource} in the resolution seam. See the module doc for the full
 * contract (dedupe last-wins on `getForFlow`, disabled-name subtraction, unfiltered `getByName`).
 *
 * @public
 */
export const createResolvedSkillSource = ({ inner, flowDisabled }: ResolvedSkillSourceDeps): SkillSource => ({
  async getForFlow(flowId: FlowId): Promise<Result<readonly Skill[], StorageError>> {
    const resolved = await inner.getForFlow(flowId);
    if (!resolved.ok) return resolved;
    const disabled = new Set(flowDisabled(flowId));
    const kept = dedupeByNameLastWins(resolved.value).filter((skill) => !disabled.has(skill.name));
    return Result.ok(kept);
  },

  // Name-resolution seam — pass through UNFILTERED (see module doc: opt-out governs auto-install,
  // never name resolution; the readiness suggestion leaf must resolve any known name).
  getByName(name: string): Promise<Result<Skill | undefined, StorageError>> {
    return inner.getByName(name);
  },
});
