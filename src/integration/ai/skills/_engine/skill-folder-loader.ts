/**
 * Shared `<root>/<name>/SKILL.md` folder loader for the operator and phase skill sources, plus the
 * `ralphctl-` install-name namespace every skill source applies.
 *
 * Resilience contract (the operator owns these skills — never fail the run for a bad one):
 *  - a missing root → empty list;
 *  - an individual unreadable / malformed SKILL.md → a logged warning, skip that skill;
 *  - the optional contract guard runs per skill as a WARNING only — the skill is STILL returned.
 */

import { type Dirent, promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '@src/business/observability/logger.ts';
import { isNodeErrnoCode } from '@src/integration/io/fs.ts';
import type { Skill } from '@src/integration/ai/skills/_engine/skill.ts';
import { parseSkill } from '@src/integration/ai/skills/_engine/parse-skill.ts';

/** Install-name namespace the adapter's `.git/info/exclude` wildcard (`…/ralphctl-*`) hides. */
export const RALPHCTL_SKILL_PREFIX = 'ralphctl-';

/** Folder-name → install-name. Idempotent so an already-prefixed folder is not doubled. */
export const namespacedSkillName = (name: string): string =>
  name.startsWith(RALPHCTL_SKILL_PREFIX) ? name : `${RALPHCTL_SKILL_PREFIX}${name}`;

/**
 * Optional per-skill compatibility guard, wired by the launcher to the shared skill-contract check.
 * Runs as a WARNING only — a violation never blocks install.
 */
export type SkillContractWarner = (skill: Skill) => void;

interface LoadSkillFoldersOptions {
  readonly root: string;
  /** Human label used in log messages and parse errors, e.g. `'operator skill'`. */
  readonly label: string;
  readonly log: Logger;
  /** Extra fields stamped on every warning (e.g. `{ provider }` or `{ flow }`). */
  readonly logFields: Readonly<Record<string, unknown>>;
  readonly warnIfContractViolated?: SkillContractWarner | undefined;
}

/** Enumerate + parse every `<root>/<name>/SKILL.md`, namespacing each install name. */
export const loadSkillFolders = async (opts: LoadSkillFoldersOptions): Promise<readonly Skill[]> => {
  const { root, label, log, logFields } = opts;

  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (cause) {
    // A missing root is the common, non-error case — nothing configured there.
    if (isNodeErrnoCode(cause, 'ENOENT')) return [];
    log.warn(`${label}s dir not readable`, { ...logFields, path: root, cause });
    return [];
  }

  const skills: Skill[] = [];
  for (const entry of entries) {
    // Only skill folders count: skip stray files (a `.provenance.json` or `README.md` at the root
    // level) and dotfile directories (`.git`, editor cruft) so neither becomes a spurious skill.
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const name = entry.name;
    // Read ONLY `SKILL.md`; sidecars such as `.provenance.json` in the same folder are never touched.
    const path = join(root, name, 'SKILL.md');
    let raw: string;
    try {
      raw = await fs.readFile(path, 'utf-8');
    } catch (cause) {
      log.warn(`${label} not readable, skipping`, { ...logFields, name, path, cause });
      continue;
    }
    const parsed = parseSkill(label, path, name, raw);
    if (!parsed.ok) {
      log.warn(`${label} invalid, skipping`, { ...logFields, name, path, error: parsed.error.message });
      continue;
    }
    // Namespace the install name so the adapter's `ralphctl-*` exclude wildcard hides it from
    // `git status` and the tracked uninstall reclaims it — exactly the bundled lifecycle.
    const skill: Skill = { ...parsed.value, name: namespacedSkillName(parsed.value.name) };
    // Compatibility guard is advisory: log a warning but still install — the operator owns it.
    opts.warnIfContractViolated?.(skill);
    skills.push(skill);
  }
  return skills;
};
