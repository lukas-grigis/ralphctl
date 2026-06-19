import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { needsMigration as markerNeedsMigration } from '@src/integration/persistence/data-migration/version-marker.ts';
import { dryRun as scanDryRun } from '@src/integration/persistence/data-migration/dry-run.ts';
import {
  apply as applyMigration,
  type ApplyCtx,
  type ApplyResult,
} from '@src/integration/persistence/data-migration/apply.ts';
import type { DryRunReport } from '@src/integration/persistence/data-migration/types.ts';

/**
 * The migration engine, packaged as one cohesive object the consent-splash flow (Wave 2b) drives.
 * The three operations are exposed in the order the splash uses them:
 *
 *   1. {@link DataMigrationEngine.needsMigration} — gate. Mount the splash ONLY when this is `true`
 *      in an interactive TTY; a non-TTY / headless / CI launch skips silently and runs on the
 *      Wave-1 tolerant readers (re-offered next launch).
 *   2. {@link DataMigrationEngine.dryRun} — populate the splash summary (counts of planned renames
 *      + any problems). Touches NOTHING on disk.
 *   3. {@link DataMigrationEngine.apply} — on consent: lock-guard → backup → atomic per-item renames
 *      → learnings.md backfill → stamp the marker. Returns a discriminated {@link ApplyResult}.
 *
 * Nothing in the app calls this at runtime yet — the launch pre-flight wiring is Wave 2b. There is
 * no top-level side effect here; the engine never auto-runs.
 *
 * @public
 */
export interface DataMigrationEngine {
  readonly needsMigration: (dataRoot: AbsolutePath) => Promise<boolean>;
  readonly dryRun: (dataRoot: AbsolutePath) => Promise<DryRunReport>;
  readonly apply: (dataRoot: AbsolutePath, report: DryRunReport, ctx: ApplyCtx) => Promise<ApplyResult>;
}

/**
 * Build the data-migration engine. A factory (not a module-level singleton) so callers can wire a
 * test double, and so the engine carries no hidden global state. Pure construction — no I/O.
 *
 * @public
 */
export const createDataMigrationEngine = (): DataMigrationEngine => ({
  needsMigration: markerNeedsMigration,
  dryRun: scanDryRun,
  apply: applyMigration,
});
