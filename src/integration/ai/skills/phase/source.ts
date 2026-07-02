/**
 * `createPhaseSkillSource` — a {@link SkillSource} backed by GLOBAL, FLOW-scoped opt-in skills
 * under `<operatorSkillsRoot>/<flowDir>/<name>/SKILL.md`.
 *
 * This is the provider-agnostic sibling of the operator source (`operator/source.ts`). Both read
 * the same global ralphctl home (`<appRoot>/skills`, computed by `storagePathsFromRoot`), but they
 * partition it differently:
 *
 *   - operator source → `<root>/<providerDir>/<name>/SKILL.md`  (per-provider: `claude/ copilot/ codex/`)
 *   - phase source    → `<root>/<flowDir>/<name>/SKILL.md`      (per-flow:     `refine/ plan/ …`)
 *
 * The flow subdirectories and the provider subdirectories are siblings under the same root, so the
 * two name sets MUST stay disjoint — a test in `tests/integration/ai/skills/phase/source.test.ts`
 * asserts `values(PHASE_FLOW_DIR) ∩ values(OPERATOR_PROVIDER_DIR) = ∅`.
 *
 * Directory convention — each recognised {@link FlowId} maps to its kebab-case directory via
 * {@link PHASE_FLOW_DIR}. Every id is its own kebab form except `createPr`, whose directory is
 * `create-pr` (matching the orchestration flow id). The phase folder is the single opt-in truth:
 * the TUI catalog copies a bundled skill folder into `<root>/<flow>/` to enable it and removes it
 * to disable it (see the plan of record) — so this source simply enumerates whatever is present.
 *
 * Flow-scoped, NOT provider-scoped: `getForFlow(flowId)` reads ONLY that flow's directory and has
 * no provider dimension. `getByName` searches every flow directory in the canonical {@link FLOW_IDS}
 * order and returns the FIRST match; missing directories are silently skipped.
 *
 * Namespacing is identical to the operator + bundled sources: each skill's install `name` is
 * prefixed with `ralphctl-` on the way out (idempotently — an already-prefixed folder is not
 * doubled), so the adapter's `.git/info/exclude` wildcard (`…/ralphctl-*`) hides these folders from
 * `git status` and the tracked uninstall reclaims them. The on-disk folder name and frontmatter
 * `name` stay un-prefixed; the prefix is applied only to the emitted {@link Skill} record.
 *
 * Only `SKILL.md` is ever read from a skill folder. A later task stamps a `.provenance.json` sidecar
 * next to it inside the same folder; that sidecar (and any other non-`SKILL.md` file) is ignored —
 * the {@link Skill} record is derived from `SKILL.md` alone. Dotfile directory entries (`.git`, …)
 * are skipped so they never produce a spurious "not readable" warning.
 *
 * Resilience contract (identical to the operator source — the operator owns these skills, never
 * fail the run for a bad one):
 *  - a missing `<root>/<flowDir>` directory → empty list (no opt-in skills for that flow);
 *  - an individual unreadable / malformed SKILL.md → a logged warning, skip that skill;
 *  - the optional contract guard (`warnIfContractViolated`) runs per skill as a WARNING only —
 *    a violation is logged and the skill is STILL returned for install.
 */

import { type Dirent, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { FLOW_IDS } from '@src/domain/value/flow-id.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { Skill } from '@src/integration/ai/skills/_engine/skill.ts';
import type { SkillSource } from '@src/integration/ai/skills/_engine/skill-source.ts';
import type { FlowId } from '@src/integration/ai/skills/_engine/registry.ts';
import { errorCode, parseSkill } from '@src/integration/ai/skills/_engine/parse-skill.ts';

/**
 * Map each {@link FlowId} to its kebab-case opt-in phase subdirectory. Every id is its own kebab
 * form EXCEPT `createPr`, whose on-disk directory is `create-pr` (matching the orchestration flow
 * id). The TUI skill catalog imports this to decide where to copy an enabled skill folder.
 *
 * The values here MUST stay disjoint from {@link OPERATOR_PROVIDER_DIR}'s values — both sets of
 * directory names share the `<appRoot>/skills` parent (see the module doc). `source.test.ts` guards
 * the invariant against future edits to either mapping.
 *
 * @public
 */
export const PHASE_FLOW_DIR: Record<FlowId, string> = {
  refine: 'refine',
  plan: 'plan',
  implement: 'implement',
  readiness: 'readiness',
  ideate: 'ideate',
  // camelCase FlowId `createPr` → kebab-case directory `create-pr` (the orchestration flow id).
  createPr: 'create-pr',
};

/**
 * Optional per-skill compatibility guard. Wired by the launcher to the shared skill-contract
 * check; runs as a WARNING only — a violation never blocks install. Left optional so this source
 * has no hard dependency on the guard: when unset, every skill is returned without a contract check.
 *
 * @public
 */
export type SkillContractWarner = (skill: Skill) => void;

/**
 * Folder-name → install-name. Idempotent so an already-prefixed folder is not doubled. Replicated
 * from the operator source (sibling-isolation forbids a cross-source import); the `ralphctl-`
 * namespace and its behaviour are identical.
 */
const RALPHCTL_SKILL_PREFIX = 'ralphctl-';
const namespaced = (folderName: string): string =>
  folderName.startsWith(RALPHCTL_SKILL_PREFIX) ? folderName : `${RALPHCTL_SKILL_PREFIX}${folderName}`;

/**
 * Factory input for {@link createPhaseSkillSource}. Mirrors the operator source's deps minus the
 * provider dimension — phase skills are flow-scoped, not provider-scoped.
 *
 * @public
 */
export interface PhaseSkillSourceDeps {
  /** `<appRoot>/skills` — the same global root the operator source reads (from `StoragePaths`). */
  readonly operatorSkillsRoot: AbsolutePath;
  /** Logged warnings for unreadable / malformed / contract-violating skills. */
  readonly logger: Logger;
  /** Optional contract guard — runs per skill as a WARNING (see {@link SkillContractWarner}). */
  readonly warnIfContractViolated?: SkillContractWarner;
}

/**
 * Enumerate + parse every `<root>/<flowDir>/<name>/SKILL.md` for one flow. Best-effort: a missing
 * flow directory yields `[]`; an unreadable / malformed individual skill is logged and skipped;
 * dotfile directory entries and non-directory entries (stray files, sidecars) are ignored. The
 * contract guard (when supplied) runs per surviving skill as a warning and never drops it.
 */
const loadFlowSkills = async (deps: PhaseSkillSourceDeps, flowId: FlowId): Promise<readonly Skill[]> => {
  const log = deps.logger.named('skills.phase');
  const flowDir = PHASE_FLOW_DIR[flowId];
  const flowRoot = join(String(deps.operatorSkillsRoot), flowDir);

  let entries: Dirent[];
  try {
    entries = await fs.readdir(flowRoot, { withFileTypes: true });
  } catch (cause) {
    // A missing flow directory is the common, non-error case — nothing opted in for this flow.
    if (errorCode(cause) === 'ENOENT') return [];
    log.warn('phase skills dir not readable', { flow: flowId, path: flowRoot, cause });
    return [];
  }

  const skills: Skill[] = [];
  for (const entry of entries) {
    // Only skill folders count: skip stray files (a `.provenance.json` or `README.md` at the flow
    // level) and dotfile directories (`.git`, editor cruft) so neither becomes a spurious skill.
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const name = entry.name;
    // Read ONLY `SKILL.md`. A `.provenance.json` sidecar inside the same folder is never touched.
    const path = join(flowRoot, name, 'SKILL.md');
    let raw: string;
    try {
      raw = await fs.readFile(path, 'utf-8');
    } catch (cause) {
      log.warn('phase skill not readable, skipping', { flow: flowId, name, path, cause });
      continue;
    }
    const parsed = parseSkill('phase skill', path, name, raw);
    if (!parsed.ok) {
      log.warn('phase skill invalid, skipping', { flow: flowId, name, path, error: parsed.error.message });
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

/** @public */
export const createPhaseSkillSource = (deps: PhaseSkillSourceDeps): SkillSource => ({
  async getForFlow(flowId: FlowId): Promise<Result<readonly Skill[], StorageError>> {
    return Result.ok(await loadFlowSkills(deps, flowId));
  },

  async getByName(name: string): Promise<Result<Skill | undefined, StorageError>> {
    // Search every flow directory in the canonical FLOW_IDS order; the FIRST match wins. Loading in
    // parallel and then scanning results in order keeps that ordering deterministic. Missing dirs
    // resolve to `[]` and are skipped.
    const perFlow = await Promise.all(FLOW_IDS.map((flowId) => loadFlowSkills(deps, flowId)));
    for (const skills of perFlow) {
      const hit = skills.find((s) => s.name === name);
      if (hit) return Result.ok(hit);
    }
    return Result.ok(undefined);
  },
});
