/**
 * `SkillCatalogPort` — the port the TUI skill-catalog view drives to enable / disable / update
 * bundled skills per flow. Port-shaped, so the interface lives in `_engine/` (shared) while the
 * concrete implementation lives in `phase/catalog.ts` (a later task).
 *
 * The catalog's single unit of truth is the filesystem: a skill is "enabled for a flow" iff its
 * folder exists under `<appRoot>/skills/<flow>/<name>/`. Enable copies the bundled folder in and
 * writes a `.provenance.json` stamp next to the copied `SKILL.md`; disable removes the folder.
 * The provenance stamp (see `phase/provenance.ts`) is what lets `list()` report whether each
 * install is in-sync with the bundle, has an upstream update available, or was locally edited.
 *
 * This module deliberately exports interfaces + the {@link SkillInstallStatus} union only — no
 * behaviour. Keeping the status vocabulary here (rather than in `phase/provenance.ts`) means the
 * port and the provenance engine share one definition without `_engine/` reaching into a sibling.
 */

import type { Result } from '@src/domain/result.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { FlowId } from '@src/domain/value/flow-id.ts';

/**
 * Sync state of one on-disk skill copy relative to its bundled origin:
 *  - `manual`           — folder has no `.provenance.json`; a skill the operator dropped in by
 *                         hand. Never ours to overwrite or remove via `update`/`updateAll`.
 *  - `in-sync`          — folder matches its stamp AND the stamp matches the current bundle.
 *  - `update-available` — folder still matches its stamp, but the bundled skill changed upstream.
 *  - `locally-modified` — the folder's `SKILL.md` diverges from its stamp (the operator edited
 *                         the copy). Wins over `update-available` so an edit is never silently lost.
 *  - `broken`           — the folder exists but has no readable `SKILL.md` (e.g. an interrupted
 *                         copy). It loads nothing and would otherwise be invisible; `disable`
 *                         removes it, and `update` on a bundled name repairs it.
 *
 * @public
 */
export type SkillInstallStatus = 'manual' | 'in-sync' | 'update-available' | 'locally-modified' | 'broken';

/** One flow where a catalog skill is installed, plus that copy's sync status. @public */
export interface SkillCatalogInstall {
  readonly flow: FlowId;
  readonly status: SkillInstallStatus;
}

/**
 * A row in the catalog view: one bundled skill, its registry-derived default/recommended phases,
 * and where it is currently installed on disk. `installs` is empty when the skill is enabled
 * nowhere.
 *
 * @public
 */
export interface SkillCatalogEntry {
  /** `ralphctl-*` id — matches the bundled folder name. */
  readonly name: string;
  /** One-line description carried through from the bundled `SKILL.md` frontmatter. */
  readonly description: string;
  /** Phases where this skill is default-ON (registry `defaultFor`). */
  readonly defaultFor: readonly FlowId[];
  /** Phases the catalog suggests opting in to (registry `recommendedFor`; may overlap `defaultFor`). */
  readonly recommendedFor: readonly FlowId[];
  /** Every flow whose phase dir currently holds a copy of this skill, with its sync status. */
  readonly installs: readonly SkillCatalogInstall[];
}

/**
 * Output port backing the TUI skill catalog. All operations are `Result`-returning and idempotent
 * where the filesystem allows it.
 *
 * @public
 */
export interface SkillCatalogPort {
  /**
   * One entry per bundled catalog skill, each carrying its registry defaults/recommendations and
   * the per-flow `installs` derived from the phase folders + their provenance stamps. A hard I/O
   * failure while scanning the phase dirs surfaces as `StorageError`; a folder without a stamp is
   * reported as a `manual` install, not an error.
   */
  list(): Promise<Result<readonly SkillCatalogEntry[], StorageError>>;
  /**
   * Copy the bundled skill folder into each `<appRoot>/skills/<flow>/<name>/` and write a
   * `.provenance.json` stamp beside the copied `SKILL.md`. Idempotent for an in-sync install
   * (re-writing identical bytes); an unstamped copy whose bytes equal the current bundle is
   * repaired (re-stamped) rather than skipped. A `locally-modified` or genuinely `manual` copy is
   * left untouched and reported in `skipped` — the caller routes the operator through `update`
   * (with confirmation) to overwrite local edits. The outcome names exactly which flows were
   * written vs left alone so the caller's feedback never overstates what happened.
   */
  enable(
    name: string,
    flows: readonly FlowId[]
  ): Promise<Result<{ readonly copied: readonly FlowId[]; readonly skipped: readonly FlowId[] }, StorageError>>;
  /**
   * Remove the skill folder (and its sidecar) from each named flow's phase dir. A folder that is
   * already absent is a no-op. Only touches the `ralphctl-*` copies the catalog manages — never an
   * operator/project skill.
   */
  disable(name: string, flows: readonly FlowId[]): Promise<Result<void, StorageError>>;
  /**
   * Overwrite the phase-folder copy in each named flow with the current bundled content and
   * re-stamp. `update` always overwrites, discarding any local edits, so the caller MUST confirm
   * before updating a `locally-modified` copy — the confirmation gate is a caller (TUI) concern.
   */
  update(name: string, flows: readonly FlowId[]): Promise<Result<void, StorageError>>;
  /**
   * Update every install whose status is `update-available`, skipping `locally-modified` (never
   * silently discard edits) and `manual` (no stamp — not ours to touch). Returns the skill names
   * actually updated so the caller can report what changed.
   */
  updateAll(): Promise<Result<{ readonly updated: readonly string[] }, StorageError>>;
}
