/**
 * `createOperatorSkillSource` — a {@link SkillSource} backed by GLOBAL, provider-specific
 * operator drop-in skills under `<operatorSkillsRoot>/<providerDir>/<name>/SKILL.md`.
 *
 * The operator authors skills once, per provider, under the ralphctl home (`<appRoot>/skills`,
 * computed by `storagePathsFromRoot`). There is NO per-project operator location — this global
 * root is the single source. At flow launch the source is built for the run's RESOLVED provider
 * and enumerates only that provider's subdirectory; other providers' subdirs are ignored. The
 * resulting {@link Skill}s are installed through the same {@link SkillsAdapter} path as bundled
 * skills (same `ralphctl-` namespace, same `.git/info/exclude` wildcard, same tracked
 * install / uninstall) — so the launcher composes this source alongside the bundled one and the
 * existing install-skills leaf installs both.
 *
 * Each skill's `name` is namespaced with the `ralphctl-` prefix on the way out (matching the
 * bundled + project sources), so the adapter's `.git/info/exclude` wildcard (`…/ralphctl-*`)
 * hides operator folders from `git status` exactly as it hides bundled ones. The prefix is
 * idempotent — an operator who already names a folder `ralphctl-foo` is not double-prefixed.
 * The on-disk folder name (and frontmatter `name`) stay un-prefixed; the prefix is applied only
 * to the emitted {@link Skill} record.
 *
 * Operator skills are provider-scoped, not flow-scoped: `getForFlow` ignores `flowId` and
 * returns the provider's full set for every skill-mounting flow. They are NOT in `FLOW_SKILLS`.
 *
 * Resilience contract (the operator owns these skills — never fail the run for a bad one):
 *  - a missing `<root>/<providerDir>` directory → empty list (no operator skills configured);
 *  - an individual unreadable / malformed SKILL.md → a logged warning, skip that skill;
 *  - the optional contract guard (`warnIfContractViolated`) runs per skill as a WARNING only —
 *    a violation is logged and the skill is STILL returned for install.
 */

import { type Dirent, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { AiProvider } from '@src/domain/entity/settings.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { Skill } from '@src/integration/ai/skills/_engine/skill.ts';
import type { SkillSource } from '@src/integration/ai/skills/_engine/skill-source.ts';
import type { FlowId } from '@src/integration/ai/skills/_engine/registry.ts';
import { errorCode, parseSkill } from '@src/integration/ai/skills/_engine/parse-skill.ts';

/**
 * Map each provider id to its short, ergonomic operator subdirectory name. The operator types
 * `<skillsRoot>/claude/<name>/SKILL.md` rather than the verbose provider id — these are the
 * canonical keys and the only ones enumerated.
 *
 *   claude-code    → `claude`
 *   github-copilot → `copilot`
 *   openai-codex   → `codex`
 */
export const OPERATOR_PROVIDER_DIR: Record<AiProvider, string> = {
  'claude-code': 'claude',
  'github-copilot': 'copilot',
  'openai-codex': 'codex',
};

/**
 * Optional per-skill compatibility guard. Wired by the launcher to the shared skill-contract
 * check (CS-SA); runs as a WARNING only — a violation never blocks install. Left optional so
 * this source has no hard dependency on the guard landing: when unset, every skill is returned
 * without a contract check.
 */
export type SkillContractWarner = (skill: Skill) => void;

/** Folder-name → install-name. Idempotent so an already-prefixed folder is not doubled. @public */
export const RALPHCTL_SKILL_PREFIX = 'ralphctl-';
const namespaced = (folderName: string): string =>
  folderName.startsWith(RALPHCTL_SKILL_PREFIX) ? folderName : `${RALPHCTL_SKILL_PREFIX}${folderName}`;

export interface OperatorSkillSourceDeps {
  /** `<appRoot>/skills` — the global operator skills root (from `StoragePaths`). */
  readonly operatorSkillsRoot: AbsolutePath;
  /** The flow's RESOLVED provider — selects which `<root>/<providerDir>` subtree to enumerate. */
  readonly provider: AiProvider;
  /** Logged warnings for unreadable / malformed / contract-violating skills. */
  readonly logger: Logger;
  /** Optional contract guard — runs per skill as a WARNING (see {@link SkillContractWarner}). */
  readonly warnIfContractViolated?: SkillContractWarner;
}

/**
 * Enumerate + parse every `<providerRoot>/<name>/SKILL.md`. Best-effort: a missing provider
 * root yields `[]`; an unreadable / malformed individual skill is logged and skipped. The
 * contract guard (when supplied) runs per surviving skill as a warning and never drops it.
 */
const loadOperatorSkills = async (deps: OperatorSkillSourceDeps): Promise<readonly Skill[]> => {
  const log = deps.logger.named('skills.operator');
  const providerDir = OPERATOR_PROVIDER_DIR[deps.provider];
  const providerRoot = join(String(deps.operatorSkillsRoot), providerDir);

  let entries: Dirent[];
  try {
    entries = await fs.readdir(providerRoot, { withFileTypes: true });
  } catch (cause) {
    // A missing root is the common, non-error case — no operator skills configured.
    if (errorCode(cause) === 'ENOENT') return [];
    log.warn('operator skills dir not readable', { provider: deps.provider, path: providerRoot, cause });
    return [];
  }

  const skills: Skill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    const path = join(providerRoot, name, 'SKILL.md');
    let raw: string;
    try {
      raw = await fs.readFile(path, 'utf-8');
    } catch (cause) {
      log.warn('operator skill not readable, skipping', { provider: deps.provider, name, path, cause });
      continue;
    }
    const parsed = parseSkill('operator skill', path, name, raw);
    if (!parsed.ok) {
      log.warn('operator skill invalid, skipping', {
        provider: deps.provider,
        name,
        path,
        error: parsed.error.message,
      });
      continue;
    }
    // Namespace the install name so the adapter's `ralphctl-*` exclude wildcard hides it from
    // `git status` and the tracked uninstall reclaims it — exactly the bundled lifecycle.
    const skill: Skill = { ...parsed.value, name: namespaced(parsed.value.name) };
    // Compatibility guard is advisory: log a warning but still install — the operator owns it.
    deps.warnIfContractViolated?.(skill);
    skills.push(skill);
  }
  return skills;
};

export const createOperatorSkillSource = (deps: OperatorSkillSourceDeps): SkillSource => ({
  async getForFlow(_flowId: FlowId): Promise<Result<readonly Skill[], StorageError>> {
    void _flowId; // operator skills are provider-scoped, not flow-scoped
    return Result.ok(await loadOperatorSkills(deps));
  },

  async getByName(name: string): Promise<Result<Skill | undefined, StorageError>> {
    const all = await loadOperatorSkills(deps);
    return Result.ok(all.find((s) => s.name === name));
  },
});
