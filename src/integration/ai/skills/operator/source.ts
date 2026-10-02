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
 * returns the provider's full set for every skill-mounting flow. They are NOT in `BUNDLED_SKILLS`.
 *
 * Resilience contract (the operator owns these skills — never fail the run for a bad one):
 *  - a missing `<root>/<providerDir>` directory → empty list (no operator skills configured);
 *  - an individual unreadable / malformed SKILL.md → a logged warning, skip that skill;
 *  - the optional contract guard (`warnIfContractViolated`) runs per skill as a WARNING only —
 *    a violation is logged and the skill is STILL returned for install.
 */

import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { AiProvider } from '@src/domain/entity/settings.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { Skill } from '@src/integration/ai/skills/_engine/skill.ts';
import type { SkillSource } from '@src/integration/ai/skills/_engine/skill-source.ts';
import type { FlowId } from '@src/integration/ai/skills/_engine/registry.ts';
import { loadSkillFolders, type SkillContractWarner } from '@src/integration/ai/skills/_engine/skill-folder-loader.ts';

/**
 * Map each provider id to its short, ergonomic operator subdirectory name. The operator types
 * `<skillsRoot>/claude/<name>/SKILL.md` rather than the verbose provider id — these are the
 * canonical keys and the only ones enumerated.
 *
 *   claude-code    → `claude`
 *   github-copilot → `copilot`
 *   openai-codex   → `codex`
 *   opencode       → `opencode`
 */
export const OPERATOR_PROVIDER_DIR: Record<AiProvider, string> = {
  'claude-code': 'claude',
  'github-copilot': 'copilot',
  'openai-codex': 'codex',
  opencode: 'opencode',
  'xai-grok': 'grok',
};

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
const loadOperatorSkills = (deps: OperatorSkillSourceDeps): Promise<readonly Skill[]> =>
  loadSkillFolders({
    root: join(String(deps.operatorSkillsRoot), OPERATOR_PROVIDER_DIR[deps.provider]),
    label: 'operator skill',
    log: deps.logger.named('skills.operator'),
    logFields: { provider: deps.provider },
    warnIfContractViolated: deps.warnIfContractViolated,
  });

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
