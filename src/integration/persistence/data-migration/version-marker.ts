import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';

/**
 * The current on-disk `data/` layout version this build understands. Bumped each time the layout
 * changes in a way that needs a one-time migration. v1 = legacy bare `<id>` names; v2 = the
 * human-readable `<id>--<slug>` names introduced in Wave 1.
 *
 * @public
 */
export const CURRENT_DATA_VERSION = 2;

/** Name of the version marker file under `data/`. */
export const DATA_VERSION_FILENAME = '.ralphctl-data-version.json';

/**
 * The persisted marker shape. `dataVersion` is the layout the data was last stamped at;
 * `lastWrittenByAppVersion` records the ralphctl version that stamped it, so a future failure
 * screen can name the exact version to downgrade to if a later migration goes wrong.
 *
 * @public
 */
export interface DataVersionMarker {
  readonly dataVersion: number;
  readonly lastWrittenByAppVersion: string;
}

const markerSchema = z.object({
  dataVersion: z.number().int(),
  lastWrittenByAppVersion: z.string().optional(),
});

/**
 * Absolute path of the version marker for a given `data/` root. Pure — no I/O.
 *
 * @public
 */
export const versionMarkerPath = (dataRoot: AbsolutePath): string => join(String(dataRoot), DATA_VERSION_FILENAME);

/**
 * Read the version marker. An ABSENT marker is treated as `{ dataVersion: 1 }` — the layout used
 * by every install that predates the marker. A CORRUPT / unreadable marker is likewise treated as
 * v1 rather than failing: the tolerant readers can still serve a mixed tree, and re-running the
 * migration over an already-migrated tree is a safe no-op. The returned `lastWrittenByAppVersion`
 * defaults to the empty string when the field is absent (legacy / hand-edited markers).
 *
 * Never throws — the worst case (a marker that exists but is garbage) degrades to v1, which is the
 * safe direction (re-offer the migration; tolerant readers cover the gap until it runs).
 *
 * @public
 */
export const readDataVersion = async (dataRoot: AbsolutePath): Promise<DataVersionMarker> => {
  let bytes: string;
  try {
    bytes = await fs.readFile(versionMarkerPath(dataRoot), 'utf8');
  } catch {
    return { dataVersion: 1, lastWrittenByAppVersion: '' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes);
  } catch {
    return { dataVersion: 1, lastWrittenByAppVersion: '' };
  }
  const parsed = markerSchema.safeParse(raw);
  if (!parsed.success) return { dataVersion: 1, lastWrittenByAppVersion: '' };
  return {
    dataVersion: parsed.data.dataVersion,
    lastWrittenByAppVersion: parsed.data.lastWrittenByAppVersion ?? '',
  };
};

/**
 * Stamp the version marker to the given version + app version. Written ONLY by `apply` after every
 * rename has succeeded, so a crash before this point leaves the marker absent (or at the prior
 * version) and the migration re-runs idempotently next launch. The write is NOT atomic-via-rename
 * here — a torn marker write just reads back as v1 (see {@link readDataVersion}), which re-offers
 * the migration rather than corrupting anything.
 *
 * @public
 */
export const writeDataVersion = async (
  dataRoot: AbsolutePath,
  marker: DataVersionMarker
): Promise<Result<void, StorageError>> => {
  const path = versionMarkerPath(dataRoot);
  const body = `${JSON.stringify(marker, null, 2)}\n`;
  try {
    await fs.mkdir(String(dataRoot), { recursive: true });
    await fs.writeFile(path, body, 'utf8');
    return Result.ok(undefined);
  } catch (cause) {
    return Result.error(new StorageError({ subCode: 'io', message: `marker write failed: ${path}`, path, cause }));
  }
};

/**
 * Whether the `data/` tree is pending a migration: stored version strictly below
 * {@link CURRENT_DATA_VERSION}. A stored version EQUAL to current ⇒ not pending; a stored version
 * GREATER than current (a newer ralphctl wrote this tree, then the user downgraded) ⇒ ALSO not
 * pending — we never downgrade data, the tolerant readers of the newer layout are forward-compatible
 * enough for the older binary to keep running.
 *
 * @public
 */
export const needsMigration = async (dataRoot: AbsolutePath): Promise<boolean> => {
  const { dataVersion } = await readDataVersion(dataRoot);
  return dataVersion < CURRENT_DATA_VERSION;
};
