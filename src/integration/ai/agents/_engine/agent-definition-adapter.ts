/**
 * `AgentDefinitionAdapter` — provider-specific install / uninstall of portable agent
 * definitions into an AI session's sandbox.
 *
 * Each AI provider has its own native sub-agent discovery convention:
 *  - Claude reads `<sessionDir>/.claude/agents/<name>.md`.
 *  - Copilot reads `<sessionDir>/.github/agents/<name>.agent.md`.
 *  - Codex reads `<sessionDir>/.codex/agents/<name>.toml`.
 *
 * The adapter takes a list of canonical {@link AgentDefinition}s and writes them in the format
 * the selected provider discovers, following the same shape as {@link SkillsAdapter}: `install`
 * is idempotent and *project-definitions-win* — a destination that already exists is left
 * untouched — and `uninstall` removes only the files the matching `install` wrote.
 */

import type { Result } from '@src/domain/result.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { AgentDefinition } from '@src/integration/ai/agents/_engine/agent-definition.ts';

export interface AgentDefinitionAdapter {
  /**
   * Install the given agent definitions into the AI session's sandbox at `sessionDir`. Returns
   * ok on every path including "the render step rejected a definition" (see the Copilot
   * 30000-char size guard) — the failing definition's error is returned and no file is written
   * for it. A destination that already exists (a project-authored file) is left untouched.
   *
   * Adds `ralphctl-*` tracking (so `uninstall` removes only entries this adapter created) and
   * appends the `ralphctl-*` wildcard to `.git/info/exclude` on first install so ralphctl-owned
   * agent files don't show in `git status`.
   */
  install(sessionDir: AbsolutePath, definitions: readonly AgentDefinition[]): Promise<Result<void, StorageError>>;
  /**
   * Remove only the agent definitions `install` placed at `sessionDir` (manifest-tracked).
   * Pre-existing project files are never touched. Idempotent — calling without a prior install
   * (or after a previous uninstall) is a no-op.
   */
  uninstall(sessionDir: AbsolutePath): Promise<Result<void, StorageError>>;
  /**
   * Short markdown snippet describing where this provider stores native agent definitions and
   * how the running AI session discovers them. Spliced into authoring prompts so the prompt
   * template itself stays provider-agnostic.
   */
  describeConvention(): string;
}
