/**
 * Ownership marker for the skill folders `createFilesystemSkillsAdapter` installs into a
 * session dir.
 *
 * The adapter's install manifest lives in memory and dies with the process. A run that is killed,
 * crashes, or fails between `install` and `uninstall` leaves its rendered `ralphctl-*` folders on
 * disk. Without a marker, a later run can't tell such a leftover from a project's own copy, and
 * "project copy wins" keeps the stale text shadowing every later bundled update. So every folder
 * the adapter writes carries a `.ralphctl-install.json` sidecar naming the installing process:
 *
 *   - no marker                            → project-owned: never touched
 *   - marker whose process is still alive  → a live run's install (another process, or another
 *                                            launch in this one): left alone, not tracked
 *   - marker whose process is gone, or a   → a stale leftover: the adapter deletes and rewrites it
 *     marker it can't parse                 (logging the dead pid first — see `deadPid` below)
 *
 * "Still alive" means the same process, not just the same pid: this process's own pid must carry
 * its per-process `bootId`, and another live pid must still match the `ps` identity stamped beside
 * it. A pid with no stamped identity, or one `ps` can't identify (Windows), counts as alive, which
 * errs toward deleting nothing.
 *
 * It follows the dotfile-sidecar convention of the skill catalog's `.provenance.json`
 * (`phase/provenance.ts`) but is a separate file: that stamp lives under `<appRoot>/skills/<flow>/`
 * and never reaches a session dir, while this one sits next to the `SKILL.md` the provider CLI
 * discovers. The Agent Skills layout allows extra files in a skill folder, and OpenCode lists them
 * (hidden files included) to the model when it loads a skill, so the body is plain data with no
 * instructions in it.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { processGone } from '@src/business/runs/detect-interrupted-runs.ts';
import type { ProcessIdentity } from '@src/business/runs/live-run.ts';
import { isNodeErrnoCode } from '@src/integration/io/fs.ts';
import { createProcessLiveness, currentProcessIdentity } from '@src/integration/io/process-liveness.ts';

/** Sidecar written next to every `SKILL.md` the filesystem skills adapter installs. */
export const INSTALL_MARKER_FILENAME = '.ralphctl-install.json';

/** `process.kill` only accepts int32 pids, so nothing above this can name a real process. */
const MAX_PID = 2_147_483_647;

// Tells this process's markers from a crashed earlier process that had the same pid (a container's pid 1).
const BOOT_ID = randomUUID();

const liveness = createProcessLiveness();

/** Who owns an existing skill folder, as far as the install marker can tell. */
export type SkillFolderOwnership = 'absent' | 'project-owned' | 'live-install' | 'stale-install';

/**
 * Result of {@link classifySkillFolder}. `deadPid` is set only when `ownership` is
 * `'stale-install'` and the marker's pid parsed cleanly — a caller replacing the folder can name
 * the dead process in a log line without re-reading the marker itself.
 */
export interface SkillFolderClassification {
  readonly ownership: SkillFolderOwnership;
  readonly deadPid?: number;
}

interface MarkerHolder {
  readonly pid: number;
  readonly bootId?: string;
  readonly identity?: ProcessIdentity;
}

const isIdentity = (value: unknown): value is ProcessIdentity =>
  typeof value === 'object' &&
  value !== null &&
  'startedAt' in value &&
  typeof value.startedAt === 'string' &&
  'command' in value &&
  typeof value.command === 'string';

const markerHolder = (raw: string): MarkerHolder | undefined => {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null || !('pid' in data)) return undefined;
  const { pid } = data;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || pid > MAX_PID) return undefined;
  const bootId = 'bootId' in data && typeof data.bootId === 'string' ? data.bootId : undefined;
  const identity = 'identity' in data && isIdentity(data.identity) ? data.identity : undefined;
  return { pid, ...(bootId !== undefined ? { bootId } : {}), ...(identity !== undefined ? { identity } : {}) };
};

// This process's own pid is only ours if this process wrote the marker.
const holderGone = (holder: MarkerHolder): Promise<boolean> =>
  holder.pid === process.pid ? Promise.resolve(holder.bootId !== BOOT_ID) : processGone(holder, liveness);

/** Classify the folder at `dst` by its install marker. Never throws. */
export const classifySkillFolder = async (dst: string): Promise<SkillFolderClassification> => {
  if (!existsSync(dst)) return { ownership: 'absent' };
  let raw: string;
  try {
    raw = await readFile(join(dst, INSTALL_MARKER_FILENAME), 'utf-8');
  } catch (cause) {
    // A missing marker means a project copy. Any other read failure (a file sitting at `dst`,
    // permissions) proves nothing about ownership, so leave the folder alone like a live install.
    return { ownership: isNodeErrnoCode(cause, 'ENOENT') ? 'project-owned' : 'live-install' };
  }
  const holder = markerHolder(raw);
  if (holder === undefined) return { ownership: 'stale-install' };
  if (!(await holderGone(holder))) return { ownership: 'live-install' };
  return { ownership: 'stale-install', deadPid: holder.pid };
};

/** Stamp `dst` as installed by this process. `dst` must already exist. */
export const writeInstallMarker = async (dst: string, skillName: string): Promise<void> => {
  const identity = await currentProcessIdentity();
  const marker = {
    installedBy: 'ralphctl',
    skill: skillName,
    pid: process.pid,
    bootId: BOOT_ID,
    ...(identity !== undefined ? { identity } : {}),
    installedAt: new Date().toISOString(),
  };
  await writeFile(join(dst, INSTALL_MARKER_FILENAME), `${JSON.stringify(marker, null, 2)}\n`, 'utf-8');
};
