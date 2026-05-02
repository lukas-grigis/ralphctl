/**
 * `detectProjectTooling` — setup-time inspection of repo paths for the
 * developer tooling the prompt templates surface to the AI.
 *
 * The runtime `ExternalPort` deliberately stays narrow (git + check
 * scripts), so this is an integration-layer helper rather than a port
 * method. It runs at prompt-build time only — the harness loop does not
 * depend on it.
 *
 * **Flags detected:**
 *  - `hasClaude`        — `CLAUDE.md` at repo root.
 *  - `hasCopilot`       — `.github/copilot-instructions.md` at repo root.
 *  - `hasCustomAgents`  — `.claude/agents/` directory present + non-empty.
 *  - `hasSkills`        — `.claude/skills/` directory present + non-empty.
 *  - `hasMcp`           — `.mcp.json` at repo root.
 *
 * Aggregation across multiple paths uses a logical OR — if any one repo
 * carries the artefact, the union flag is `true`. The pre-rendered
 * `rendered` markdown bullet list reflects the union (suitable for the
 * `{{PROJECT_TOOLING}}` placeholder).
 *
 * Note: ralphctl ships a similar
 * `detectProjectTooling` on the runtime ExternalPort. Reintroduced here
 * as a setup-time helper because the prompt-builder is the only consumer
 * — keeping it off the runtime port avoids dragging filesystem inspection
 * into hot paths.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';

export interface ProjectTooling {
  readonly hasClaude: boolean;
  readonly hasCopilot: boolean;
  readonly hasCustomAgents: boolean;
  readonly hasSkills: boolean;
  readonly hasMcp: boolean;
  /**
   * Pre-rendered markdown bullet list for the `{{PROJECT_TOOLING}}`
   * placeholder. Empty string when no tooling was detected — the caller
   * can substitute that directly without an extra branch.
   */
  readonly rendered: string;
}

const EMPTY: ProjectTooling = {
  hasClaude: false,
  hasCopilot: false,
  hasCustomAgents: false,
  hasSkills: false,
  hasMcp: false,
  rendered: '',
};

/** Returns true when the path exists as a regular file. */
async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

/** Returns true when the path exists as a non-empty directory. */
async function directoryHasEntries(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    if (!s.isDirectory()) return false;
    // Cheap "non-empty" probe via readdir — keeps the helper a single
    // syscall worth of work in the common (empty) case.
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(p);
    return entries.length > 0;
  } catch {
    return false;
  }
}

async function inspect(path: AbsolutePath): Promise<{
  hasClaude: boolean;
  hasCopilot: boolean;
  hasCustomAgents: boolean;
  hasSkills: boolean;
  hasMcp: boolean;
}> {
  const [hasClaude, hasCopilot, hasCustomAgents, hasSkills, hasMcp] = await Promise.all([
    fileExists(join(path, 'CLAUDE.md')),
    fileExists(join(path, '.github', 'copilot-instructions.md')),
    directoryHasEntries(join(path, '.claude', 'agents')),
    directoryHasEntries(join(path, '.claude', 'skills')),
    fileExists(join(path, '.mcp.json')),
  ]);
  return { hasClaude, hasCopilot, hasCustomAgents, hasSkills, hasMcp };
}

function render(flags: Omit<ProjectTooling, 'rendered'>): string {
  const lines: string[] = [];
  if (flags.hasClaude) lines.push('- `CLAUDE.md` — Claude Code project instructions');
  if (flags.hasCopilot) lines.push('- `.github/copilot-instructions.md` — GitHub Copilot project instructions');
  if (flags.hasCustomAgents) lines.push('- `.claude/agents/` — custom subagents available via the Task tool');
  if (flags.hasSkills) lines.push('- `.claude/skills/` — skills available to AI sessions');
  if (flags.hasMcp) lines.push('- `.mcp.json` — Model Context Protocol server configuration');

  if (lines.length === 0) return '';
  return ['## Project Tooling', '', ...lines].join('\n');
}

/**
 * Inspect every supplied path and return the union of tooling artefacts
 * detected across them. An empty input returns the canonical "nothing
 * detected" tooling — the caller can substitute `rendered` directly.
 */
export async function detectProjectTooling(paths: readonly AbsolutePath[]): Promise<ProjectTooling> {
  if (paths.length === 0) return EMPTY;

  const results = await Promise.all(paths.map(inspect));

  const hasClaude = results.some((r) => r.hasClaude);
  const hasCopilot = results.some((r) => r.hasCopilot);
  const hasCustomAgents = results.some((r) => r.hasCustomAgents);
  const hasSkills = results.some((r) => r.hasSkills);
  const hasMcp = results.some((r) => r.hasMcp);

  const flags = { hasClaude, hasCopilot, hasCustomAgents, hasSkills, hasMcp };
  return { ...flags, rendered: render(flags) };
}
