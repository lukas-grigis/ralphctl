/**
 * `createFilesystemAgentDefinitionAdapter` — shared {@link AgentDefinitionAdapter}
 * implementation backing every provider whose native sub-agent convention is "render each
 * definition to a provider-specific file under `<sessionDir>/<parentDir>/agents/` and let the
 * running CLI auto-discover it." Only the {@link RenderedAgentFile} renderer (path + content
 * shape, format, extension) and the `parentDir` / convention text differ between Claude, Copilot,
 * and Codex.
 *
 * Behaviour (identical across providers):
 *  - **Project definitions win.** If the renderer's `relPath` already exists under
 *    `sessionDir`, the user authored their own copy — leave it untouched and exclude it from
 *    the manifest.
 *  - **Manifest-tracked uninstall.** `install` records the `relPath`s it actually wrote into a
 *    per-`sessionDir` Set. `uninstall` removes only those, then attempts to clean up the
 *    `<parentDir>/agents` and `<parentDir>` directories when they end up empty.
 *  - **Idempotent.** A second `install` adds only the still-missing definitions; double-
 *    `uninstall` is a no-op.
 *  - **Renderer errors abort the batch.** A definition the renderer rejects (e.g. Copilot's
 *    30000-char body guard) returns the error immediately and writes no file for it; anything
 *    already written earlier in the same `install` call stays tracked for cleanup.
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { AgentDefinition, RenderedAgentFile } from '@src/integration/ai/agents/_engine/agent-definition.ts';
import type { AgentDefinitionAdapter } from '@src/integration/ai/agents/_engine/agent-definition-adapter.ts';
import { createSessionInstallManifest } from '@src/integration/ai/skills/_engine/session-install-support.ts';
import { messageOf } from '@src/domain/value/error/error-message.ts';

export interface FilesystemAgentDefinitionAdapterDeps {
  /** Provider id — used only for error messages. */
  readonly providerId: string;
  /**
   * Top-level directory the running CLI scans for native agent definitions (e.g. `.claude`,
   * `.github`, `.codex`). Used to build the `.git/info/exclude` wildcard and to tidy empty
   * parent dirs on uninstall — the renderer's `relPath` already embeds this prefix.
   */
  readonly parentDir: string;
  /** Renders one canonical definition into the provider's native file shape. */
  readonly renderer: (definition: AgentDefinition) => Result<RenderedAgentFile, StorageError>;
  /** Markdown sentence returned from {@link AgentDefinitionAdapter.describeConvention}. */
  readonly convention: string;
  /** Warns when the best-effort `.git/info/exclude` write fails; the install still succeeds. */
  readonly logger?: Logger;
}

/**
 * Write one rendered definition file, skipping when a project copy already exists at the
 * destination. Returns the relPath actually written (or `undefined` on a skip) so the caller
 * updates its manifest without re-deriving the join.
 */
const writeOne = async (
  sessionDir: AbsolutePath,
  providerId: string,
  definition: AgentDefinition,
  rendered: RenderedAgentFile
): Promise<Result<string | undefined, StorageError>> => {
  const dst = join(String(sessionDir), rendered.relPath);
  if (existsSync(dst)) return Result.ok(undefined); // project copy wins

  try {
    await mkdir(dirname(dst), { recursive: true });
    await writeFile(dst, rendered.content, 'utf-8');
    return Result.ok(rendered.relPath);
  } catch (cause) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `${providerId}: failed to install agent definition ${definition.name}: ${messageOf(cause)}`,
        path: dst,
        cause,
      })
    );
  }
};

/**
 * Render + write every definition, tracking each successfully-written `relPath` into `tracked`.
 * Stops at the first renderer or write failure and returns that error — whatever was already
 * added to `tracked` before the failure stays there for the caller to persist.
 */
const writeAllDefinitions = async (
  sessionDir: AbsolutePath,
  providerId: string,
  renderer: (definition: AgentDefinition) => Result<RenderedAgentFile, StorageError>,
  definitions: readonly AgentDefinition[],
  tracked: Set<string>
): Promise<Result<void, StorageError>> => {
  for (const definition of definitions) {
    const rendered = renderer(definition);
    if (!rendered.ok) return rendered;

    const written = await writeOne(sessionDir, providerId, definition, rendered.value);
    if (!written.ok) return written;
    if (written.value !== undefined) tracked.add(written.value);
  }
  return Result.ok(undefined);
};

export const createFilesystemAgentDefinitionAdapter = (
  deps: FilesystemAgentDefinitionAdapterDeps
): AgentDefinitionAdapter => {
  const manifest = createSessionInstallManifest({
    providerId: deps.providerId,
    parentDir: deps.parentDir,
    subdir: 'agents',
    noun: 'agent definitions',
    logger: deps.logger,
  });

  return {
    install(sessionDir: AbsolutePath, definitions: readonly AgentDefinition[]): Promise<Result<void, StorageError>> {
      return manifest.install(sessionDir, (tracked) =>
        writeAllDefinitions(sessionDir, deps.providerId, deps.renderer, definitions, tracked)
      );
    },

    describeConvention(): string {
      return deps.convention;
    },

    uninstall(sessionDir: AbsolutePath): Promise<Result<void, StorageError>> {
      return manifest.uninstall(sessionDir, (key, relPath) => join(key, relPath));
    },
  };
};
