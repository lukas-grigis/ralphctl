/**
 * `SkillSource` — produces a list of {@link Skill}s for a given flow.
 *
 * The bundled implementation reads from `src/ai/skills/bundled/<id>/SKILL.md`. A
 * second implementation will read user-authored skills from a configurable directory; both
 * feed the same `SkillsAdapter` so the call site doesn't change.
 *
 * The set of skills returned per flow is decided here, by the source — the canonical source
 * for "which skills apply to refine vs plan vs implement" is `ai/skills/_engine/registry.ts`,
 * which the bundled source consults. Future user-source implementations can follow their own
 * mapping (config file, naming convention, etc.) without changing the port.
 */

import type { Result } from '@src/domain/result.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Skill } from '@src/integration/ai/skills/_engine/skill.ts';
import type { FlowId } from '@src/integration/ai/skills/_engine/registry.ts';

export interface SkillSource {
  /**
   * Resolve the skills that should be installed for `flowId`. Returns an empty list when the
   * flow has no skills assigned (still ok). `StorageError` only on hard read failures the
   * caller cannot recover from (a missing source folder is a soft-fail empty list).
   */
  getForFlow(flowId: FlowId): Promise<Result<readonly Skill[], StorageError>>;
}
