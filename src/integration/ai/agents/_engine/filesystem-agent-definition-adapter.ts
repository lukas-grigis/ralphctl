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
 *
 * Mirrors {@link createFilesystemSkillsAdapter} — see that module for the rationale behind
 * sharing one implementation across siblings.
 */

import { existsSync } from 'node:fs';
import { mkdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { ensureGitExcludeWildcard } from '@src/integration/io/git-exclude.ts';
import type { AgentDefinition, RenderedAgentFile } from '@src/integration/ai/agents/_engine/agent-definition.ts';
import type { AgentDefinitionAdapter } from '@src/integration/ai/agents/_engine/agent-definition-adapter.ts';

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
  /**
   * Optional logger — used to warn when the best-effort `.git/info/exclude` write fails.
   * Install still succeeds in that case; the user just sees harness-authored `ralphctl-*`
   * files in `git status` until the exclude lands manually.
   */
  readonly logger?: Logger;
}

const tryRmdirIfEmpty = async (path: string): Promise<void> => {
  try {
    await rmdir(path);
  } catch {
    // Non-empty or missing — both are fine, the cleanup is best-effort.
  }
};

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
        message: `${providerId}: failed to install agent definition ${definition.name}: ${cause instanceof Error ? cause.message : String(cause)}`,
        path: dst,
        cause,
      })
    );
  }
};

export const createFilesystemAgentDefinitionAdapter = (
  deps: FilesystemAgentDefinitionAdapterDeps
): AgentDefinitionAdapter => {
  // Per-sessionDir manifest of relPaths this adapter created at install time. Cleared on a
  // successful uninstall. Not promised across crashed runs — the cleanup is best-effort.
  const installed = new Map<string, Set<string>>();
  // Per-sessionDir flag tracking whether we've already attempted to append the wildcard
  // exclude — avoids re-reading the file on every install call across a long-running session.
  const excludeAttempted = new Set<string>();
  const agentsSubdir = join(deps.parentDir, 'agents');
  const excludePattern = `${agentsSubdir}/ralphctl-*`;

  // Self-healing prune: drop manifest entries whose sessionDir no longer exists on disk (see
  // createFilesystemSkillsAdapter's identical `pruneStale` for the failure mode this guards).
  const pruneStale = (): void => {
    for (const key of [...installed.keys()]) {
      if (!existsSync(key)) installed.delete(key);
    }
  };

  return {
    async install(
      sessionDir: AbsolutePath,
      definitions: readonly AgentDefinition[]
    ): Promise<Result<void, StorageError>> {
      pruneStale();
      const tracked = installed.get(String(sessionDir)) ?? new Set<string>();

      for (const definition of definitions) {
        const rendered = deps.renderer(definition);
        if (!rendered.ok) {
          if (tracked.size > 0) installed.set(String(sessionDir), tracked);
          return rendered;
        }

        const written = await writeOne(sessionDir, deps.providerId, definition, rendered.value);
        if (!written.ok) {
          if (tracked.size > 0) installed.set(String(sessionDir), tracked);
          return written;
        }
        if (written.value !== undefined) tracked.add(written.value);
      }

      if (tracked.size > 0) installed.set(String(sessionDir), tracked);

      // Best-effort: append a single wildcard line to <sessionDir>/.git/info/exclude so every
      // `ralphctl-*` agent definition we manage stays out of `git status`. A non-git tree, a
      // worktree, or a write-protected `.git/info/exclude` all collapse to "warn and proceed" —
      // the install itself already succeeded.
      if (!excludeAttempted.has(String(sessionDir))) {
        excludeAttempted.add(String(sessionDir));
        const excluded = await ensureGitExcludeWildcard(sessionDir, excludePattern);
        if (!excluded.ok) {
          deps.logger
            ?.named('agents.exclude')
            .warn(`${deps.providerId}: failed to update .git/info/exclude: ${excluded.error.message}`);
        }
      }

      return Result.ok(undefined);
    },

    describeConvention(): string {
      return deps.convention;
    },

    async uninstall(sessionDir: AbsolutePath): Promise<Result<void, StorageError>> {
      const key = String(sessionDir);
      const tracked = installed.get(key);
      if (tracked === undefined || tracked.size === 0) return Result.ok(undefined);

      try {
        for (const relPath of tracked) {
          await rm(join(key, relPath), { recursive: true, force: true });
        }
        installed.delete(key);
      } catch (cause) {
        return Result.error(
          new StorageError({
            subCode: 'io',
            message: `${deps.providerId}: failed to uninstall agent definitions under ${join(key, agentsSubdir)}: ${cause instanceof Error ? cause.message : String(cause)}`,
            path: join(key, agentsSubdir),
            cause,
          })
        );
      }

      // Tidy empty parent dirs we may have created. Failure is benign — the files themselves
      // are already gone, and a non-empty parent (e.g. a project `.github/` with workflows in
      // it) is preserved by `tryRmdirIfEmpty`.
      await tryRmdirIfEmpty(join(key, agentsSubdir));
      await tryRmdirIfEmpty(join(key, deps.parentDir));
      return Result.ok(undefined);
    },
  };
};
