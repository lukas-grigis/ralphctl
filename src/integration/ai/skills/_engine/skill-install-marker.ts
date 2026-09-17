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
 * It follows the dotfile-sidecar convention of the skill catalog's `.provenance.json`
 * (`phase/provenance.ts`) but is a separate file: that stamp lives under `<appRoot>/skills/<flow>/`
 * and never reaches a session dir, while this one sits next to the `SKILL.md` the provider CLI
 * discovers. The Agent Skills layout allows extra files in a skill folder, and OpenCode lists them
 * (hidden files included) to the model when it loads a skill, so the body is plain data with no
 * instructions in it.
 *
 * A reused pid makes a dead holder look alive. The folder is then left alone until that process
 * exits, which errs toward deleting nothing.
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { errorCode } from '@src/integration/ai/skills/_engine/frontmatter.ts';

/** Sidecar written next to every `SKILL.md` the filesystem skills adapter installs. */
export const INSTALL_MARKER_FILENAME = '.ralphctl-install.json';

/** `process.kill` only accepts int32 pids, so nothing above this can name a real process. */
const MAX_PID = 2_147_483_647;

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

/**
 * Signal-0 liveness probe. `ESRCH` means the process is gone. `EPERM` means it exists but belongs
 * to another user, and any other failure proves nothing, so both count as alive.
 */
export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return errorCode(cause) !== 'ESRCH';
  }
};

const holderPid = (raw: string): number | undefined => {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null || !('pid' in data)) return undefined;
  const { pid } = data;
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && pid <= MAX_PID ? pid : undefined;
};

/** Classify the folder at `dst` by its install marker. Never throws. */
export const classifySkillFolder = async (dst: string): Promise<SkillFolderClassification> => {
  if (!existsSync(dst)) return { ownership: 'absent' };
  let raw: string;
  try {
    raw = await readFile(join(dst, INSTALL_MARKER_FILENAME), 'utf-8');
  } catch (cause) {
    // A missing marker means a project copy. Any other read failure (a file sitting at `dst`,
    // permissions) proves nothing about ownership, so leave the folder alone like a live install.
    return { ownership: errorCode(cause) === 'ENOENT' ? 'project-owned' : 'live-install' };
  }
  const pid = holderPid(raw);
  if (pid !== undefined && isProcessAlive(pid)) return { ownership: 'live-install' };
  return { ownership: 'stale-install', ...(pid !== undefined ? { deadPid: pid } : {}) };
};

/** Stamp `dst` as installed by this process. `dst` must already exist. */
export const writeInstallMarker = async (dst: string, skillName: string): Promise<void> => {
  const marker = { installedBy: 'ralphctl', skill: skillName, pid: process.pid, installedAt: new Date().toISOString() };
  await writeFile(join(dst, INSTALL_MARKER_FILENAME), `${JSON.stringify(marker, null, 2)}\n`, 'utf-8');
};
