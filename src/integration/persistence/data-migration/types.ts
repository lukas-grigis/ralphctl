import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

/**
 * What kind of `data/` entry a migration plan item is. The three families are renamed the same way
 * (bare `<id>` → `<id>--<slug>`) but read their slug from different places, so the dry-run records
 * the kind for the apply step + the splash summary (Wave 2b).
 *
 * @public
 */
export type MigrationEntryKind = 'project' | 'sprint' | 'memory';

/**
 * A single planned rename: move the legacy bare-`<id>` entry to its human-readable `<id>--<slug>`
 * name. `from` / `to` are ABSOLUTE paths (the parent dir is already folded in) so the apply step is
 * a straight `renamePath(from, to)` with no further path math. Both files (projects) and
 * directories (sprints, memory) flow through the same shape.
 *
 * @public
 */
export interface RenamePlan {
  readonly kind: MigrationEntryKind;
  readonly id: string;
  readonly slug: string;
  readonly fromName: string;
  readonly toName: string;
  readonly from: AbsolutePath;
  readonly to: AbsolutePath;
}

/**
 * An entry the dry-run intentionally LEFT ALONE without flagging it as a problem: already-migrated
 * (`<id>--<slug>` form), an unrelated file (`.DS_Store`), the version marker, etc. Skips never abort
 * the run — they are informational.
 *
 * @public
 */
export interface SkippedEntry {
  readonly name: string;
  readonly reason: string;
}

/**
 * An entry the dry-run could not safely plan a rename for: a collision (target `<id>--<slug>` already
 * exists and differs from the source), a malformed / non-uuid directory name, a missing or unreadable
 * slug inside the entry's JSON, or an unwritable backup target. A problem does NOT abort the run — the
 * problematic entry is simply left in its legacy form (the tolerant readers still find it); the splash
 * surfaces the list so the operator knows what was not touched.
 *
 * @public
 */
export interface MigrationProblem {
  readonly name: string;
  readonly reason: string;
}

/**
 * The full result of a dry-run scan. `planned` is the set of safe renames; `skipped` and `problems`
 * are the informational/blocked entries. Touches NOTHING on disk — it is purely a read-side scan.
 *
 * @public
 */
export interface DryRunReport {
  readonly planned: readonly RenamePlan[];
  readonly skipped: readonly SkippedEntry[];
  readonly problems: readonly MigrationProblem[];
}
