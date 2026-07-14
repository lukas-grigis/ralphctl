/**
 * `createOperatorAgentDefinitionSource` — an {@link AgentDefinitionSource} backed by GLOBAL
 * operator drop-in agent definitions under `<operatorAgentDefinitionsRoot>/<name>.md`.
 *
 * The operator authors an agent definition once, under the ralphctl home
 * (`<appRoot>/agents`, computed by `storagePathsFromRoot`), and it is reused across every
 * project. Unlike operator skills (`skills/operator/source.ts`), there is NO per-provider
 * subdirectory here: an agent definition's Markdown body is provider-agnostic — the per-provider
 * renderer (`agents/{claude,codex,copilot}/`) handles placement and format — so one flat
 * directory serves every provider.
 *
 * Each definition's `name` is namespaced with the `ralphctl-` prefix on the way out (matching the
 * bundled source), so composed sources dedupe consistently and the on-disk render step's
 * `.git/info/exclude` wildcard hides installed files the same way it hides bundled ones. The
 * prefix is idempotent — an operator who already names a file `ralphctl-foo.md` is not
 * double-prefixed. The on-disk file name (and frontmatter `name`) stay un-prefixed by
 * convention; the prefix is applied only to the emitted {@link AgentDefinition} record.
 *
 * Resilience contract (the operator owns these definitions — never fail the run for a bad one):
 *  - a missing `<operatorAgentDefinitionsRoot>` directory → empty list (none configured);
 *  - an individual unreadable / malformed `<name>.md` → a logged warning, skip that definition;
 *  - the optional quality guard (`warnIfVague`) runs per definition as a WARNING only — a vague
 *    definition is logged and STILL returned for install.
 */

import { type Dirent, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { AgentDefinition } from '@src/integration/ai/agents/_engine/agent-definition.ts';
import { RALPHCTL_AGENT_PREFIX } from '@src/integration/ai/agents/_engine/agent-definition.ts';
import type { AgentDefinitionSource } from '@src/integration/ai/agents/_engine/agent-definition-source.ts';
import { errorCode, parseAgentDefinition } from '@src/integration/ai/agents/_engine/parse-agent-definition.ts';

/**
 * Optional quality guard. Runs as a WARNING only — a vague definition never blocks install. Left
 * optional so this source has no hard dependency on the guard landing: when unset, every
 * definition is returned without a quality check.
 */
export type AgentDefinitionQualityWarner = (definition: AgentDefinition) => void;

/** File-base-name → install-name. Idempotent so an already-prefixed file is not doubled. @public */
const namespaced = (baseName: string): string =>
  baseName.startsWith(RALPHCTL_AGENT_PREFIX) ? baseName : `${RALPHCTL_AGENT_PREFIX}${baseName}`;

export interface OperatorAgentDefinitionSourceDeps {
  /** `<appRoot>/agents` — the global operator agent-definitions root (from `StoragePaths`). */
  readonly operatorAgentDefinitionsRoot: AbsolutePath;
  /** Logged warnings for unreadable / malformed / vague definitions. */
  readonly logger: Logger;
  /** Optional quality guard — runs per definition as a WARNING (see {@link AgentDefinitionQualityWarner}). */
  readonly warnIfVague?: AgentDefinitionQualityWarner;
}

/**
 * Enumerate + parse every `<operatorAgentDefinitionsRoot>/<name>.md`. Best-effort: a missing
 * root yields `[]`; an unreadable / malformed individual definition is logged and skipped. The
 * quality guard (when supplied) runs per surviving definition as a warning and never drops it.
 */
const loadOperatorAgentDefinitions = async (
  deps: OperatorAgentDefinitionSourceDeps
): Promise<readonly AgentDefinition[]> => {
  const log = deps.logger.named('agents.operator');
  const root = String(deps.operatorAgentDefinitionsRoot);

  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (cause) {
    // A missing root is the common, non-error case — no operator agent definitions configured.
    if (errorCode(cause) === 'ENOENT') return [];
    log.warn('operator agent definitions dir not readable', { path: root, cause });
    return [];
  }

  const definitions: AgentDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const baseName = entry.name.slice(0, -'.md'.length);
    const path = join(root, entry.name);
    let raw: string;
    try {
      raw = await fs.readFile(path, 'utf-8');
    } catch (cause) {
      log.warn('operator agent definition not readable, skipping', { name: baseName, path, cause });
      continue;
    }
    const parsed = parseAgentDefinition('operator agent definition', path, baseName, raw);
    if (!parsed.ok) {
      log.warn('operator agent definition invalid, skipping', {
        name: baseName,
        path,
        error: parsed.error.message,
      });
      continue;
    }
    // Namespace the install name so composed sources dedupe consistently and the render step's
    // `ralphctl-*` exclude wildcard hides it from `git status` — exactly the bundled lifecycle.
    const definition: AgentDefinition = { ...parsed.value, name: namespaced(parsed.value.name) };
    // Quality guard is advisory: log a warning but still install — the operator owns it.
    deps.warnIfVague?.(definition);
    definitions.push(definition);
  }
  return definitions;
};

export const createOperatorAgentDefinitionSource = (
  deps: OperatorAgentDefinitionSourceDeps
): AgentDefinitionSource => ({
  async list(): Promise<Result<readonly AgentDefinition[], StorageError>> {
    return Result.ok(await loadOperatorAgentDefinitions(deps));
  },

  async getByName(name: string): Promise<Result<AgentDefinition | undefined, StorageError>> {
    const all = await loadOperatorAgentDefinitions(deps);
    return Result.ok(all.find((d) => d.name === name));
  },
});
