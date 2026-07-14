/**
 * `createBundledAgentDefinitionSource` — implementation of {@link AgentDefinitionSource} backed
 * by the bundled `<name>.md` files that live next to this module.
 *
 * The vetted set comes from {@link BUNDLED_AGENT_DEFINITIONS}. For each name in that list, the
 * source reads `<bundledRoot>/<name>.md` and parses YAML frontmatter (`name`, `description`,
 * optional `model` / `effort` — frontmatter `name` must match the file's base name) into the
 * canonical {@link AgentDefinition} record.
 *
 * Resolution of the bundled root mirrors `skills/bundled/source.ts`'s `resolveBundledRoot`: in
 * dev (`tsx`) the `.md` files sit next to this module; in a production bundle
 * `scripts/build-assets.ts` copies them into `dist/agent-definitions/`, so `import.meta.url`
 * resolves correctly in both modes. Detection asks the filesystem (does an `agent-definitions/`
 * dir sit beside this module?), not the chunk filename — tsup code-splitting rewrites
 * `import.meta.url` to a hashed chunk, and a filename check would miss it (see the skills
 * module's doc comment for the incident this guards against). Tests can override the root via
 * `bundledRoot`.
 *
 * Parsing failures (missing file, malformed frontmatter, missing required fields) return a
 * `StorageError` with `subCode: 'parse'`.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AgentDefinition } from '@src/integration/ai/agents/_engine/agent-definition.ts';
import type { AgentDefinitionSource } from '@src/integration/ai/agents/_engine/agent-definition-source.ts';
import { BUNDLED_AGENT_DEFINITIONS } from '@src/integration/ai/agents/_engine/registry.ts';
import { errorCode, parseAgentDefinition } from '@src/integration/ai/agents/_engine/parse-agent-definition.ts';

/**
 * Resolve the default bundled-agent-definition root from a module URL. `exists` is injectable
 * for tests.
 *
 *   Dev (tsx): this module lives at src/integration/ai/agents/bundled/source.ts — `.md` files
 *     sit next to it.
 *   Build (tsup): `scripts/build-assets.ts` copies the `.md` files to `<dist>/agent-definitions/`.
 *
 * @public
 */
export const resolveBundledRoot = (moduleUrl: string, exists: (path: string) => boolean = existsSync): string => {
  const here = dirname(fileURLToPath(moduleUrl));
  const beside = join(here, 'agent-definitions');
  return exists(beside) ? beside : here;
};

const defaultBundledRoot = resolveBundledRoot(import.meta.url);

export interface BundledAgentDefinitionSourceDeps {
  /** Override for tests. Production resolves the bundled root next to this module. */
  readonly bundledRoot?: string;
}

/** Read + parse a `<name>.md` when the file is REQUIRED — a missing file is a hard `io` error. */
const readDefinition = async (root: string, name: string): Promise<Result<AgentDefinition, StorageError>> => {
  const path = join(root, `${name}.md`);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (cause) {
    return Result.error(
      new StorageError({ subCode: 'io', message: `bundled agent definition not readable: ${path}`, path, cause })
    );
  }
  return parseAgentDefinition('bundled agent definition', path, name, raw);
};

/**
 * Read + parse a `<name>.md` when the file is OPTIONAL — absence means the name is unknown. A
 * single async read attempt avoids a TOCTOU window: a missing file (`ENOENT`) resolves to
 * `ok(undefined)`; any other read failure or a malformed body surfaces as a `StorageError`.
 */
const readDefinitionOptional = async (
  root: string,
  name: string
): Promise<Result<AgentDefinition | undefined, StorageError>> => {
  const path = join(root, `${name}.md`);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (cause) {
    if (errorCode(cause) === 'ENOENT') return Result.ok(undefined);
    return Result.error(
      new StorageError({ subCode: 'io', message: `bundled agent definition not readable: ${path}`, path, cause })
    );
  }
  return parseAgentDefinition('bundled agent definition', path, name, raw);
};

export const createBundledAgentDefinitionSource = (
  deps: BundledAgentDefinitionSourceDeps = {}
): AgentDefinitionSource => {
  const root = deps.bundledRoot ?? defaultBundledRoot;
  const cache = new Map<string, AgentDefinition>();

  const loadOne = async (name: string): Promise<Result<AgentDefinition, StorageError>> => {
    const cached = cache.get(name);
    if (cached !== undefined) return Result.ok(cached);
    const r = await readDefinition(root, name);
    if (r.ok) cache.set(name, r.value);
    return r;
  };

  return {
    async list(): Promise<Result<readonly AgentDefinition[], StorageError>> {
      const definitions: AgentDefinition[] = [];
      for (const name of BUNDLED_AGENT_DEFINITIONS) {
        const r = await loadOne(name);
        if (!r.ok) return Result.error(r.error);
        definitions.push(r.value);
      }
      return Result.ok(definitions);
    },

    async getByName(name: string): Promise<Result<AgentDefinition | undefined, StorageError>> {
      const cached = cache.get(name);
      if (cached !== undefined) return Result.ok(cached);
      const r = await readDefinitionOptional(root, name);
      if (r.ok && r.value !== undefined) cache.set(name, r.value);
      return r;
    },
  };
};
