import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Project tooling detection.
 *
 * Surfaces project- and user-specific resources (Claude subagents, skills,
 * MCP servers, instruction files) so the evaluator can be told to use them.
 *
 * Per the harness-design article, evaluators that *interact* with the system
 * via available tools (Playwright, sub-agents, etc.) catch many issues that a
 * static diff review misses. This module is the discovery layer.
 *
 * All checks are synchronous, best-effort, and never throw — failure to read a
 * file or list a directory degrades to "not detected" rather than blowing up
 * the evaluator spawn path.
 */

export interface ProjectTooling {
  /** Subagent file basenames (without `.md`) found in `.claude/agents/`. */
  agents: string[];
  /** Top-level skill directory names found in `.claude/skills/`. */
  skills: string[];
  /** MCP server names declared in `.mcp.json` (top-level `mcpServers` keys). */
  mcpServers: string[];
  /** True if the project has a CLAUDE.md instruction file at its root. */
  hasClaudeMd: boolean;
  /** True if the project has an AGENTS.md instruction file at its root. */
  hasAgentsMd: boolean;
  /** True if the project has a `.github/copilot-instructions.md` file. */
  hasCopilotInstructions: boolean;
}

const EMPTY_TOOLING: ProjectTooling = {
  agents: [],
  skills: [],
  mcpServers: [],
  hasClaudeMd: false,
  hasAgentsMd: false,
  hasCopilotInstructions: false,
};

function safeListDir(path: string, predicate: (name: string) => boolean): string[] {
  try {
    if (!existsSync(path)) return [];
    return readdirSync(path).filter(predicate).sort();
  } catch {
    return [];
  }
}

/**
 * Agents that should never be delegated to FROM the evaluator.
 * - `implementer` IS the generator — delegating evaluation to it defeats the
 *   independent-review purpose of the gen-eval split.
 * - `planner` writes specs, not reviews — wrong tool for the job.
 *
 * Filtered out at detection time so they never appear in the rendered prompt.
 * Models routinely ignore negative instructions in long contexts; the cleaner
 * fix is to never list them at all.
 */
const EVALUATOR_DENYLISTED_AGENTS = new Set(['implementer', 'planner']);

function detectAgents(projectPath: string): string[] {
  const agentsDir = join(projectPath, '.claude', 'agents');
  return safeListDir(agentsDir, (name) => name.endsWith('.md'))
    .map((name) => name.replace(/\.md$/, ''))
    .filter((name) => !EVALUATOR_DENYLISTED_AGENTS.has(name));
}

function detectSkills(projectPath: string): string[] {
  const skillsDir = join(projectPath, '.claude', 'skills');
  try {
    if (!existsSync(skillsDir)) return [];
    return readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function detectMcpServers(projectPath: string): string[] {
  const mcpFile = join(projectPath, '.mcp.json');
  if (!existsSync(mcpFile)) return [];
  try {
    const raw = readFileSync(mcpFile, 'utf-8');
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    const servers = parsed.mcpServers;
    if (!servers || typeof servers !== 'object') return [];
    return Object.keys(servers).sort();
  } catch {
    return [];
  }
}

/**
 * Detect project-specific tooling at the given project root.
 * Always returns a populated object; missing tooling is represented as empty
 * arrays / false flags so callers can render conditional sections cleanly.
 */
export function detectProjectTooling(projectPath: string): ProjectTooling {
  if (!projectPath || !existsSync(projectPath)) {
    return EMPTY_TOOLING;
  }

  return {
    agents: detectAgents(projectPath),
    skills: detectSkills(projectPath),
    mcpServers: detectMcpServers(projectPath),
    hasClaudeMd: existsSync(join(projectPath, 'CLAUDE.md')),
    hasAgentsMd: existsSync(join(projectPath, 'AGENTS.md')),
    hasCopilotInstructions: existsSync(join(projectPath, '.github', 'copilot-instructions.md')),
  };
}

/**
 * Detect tooling across multiple project paths and return the union — used by
 * the planner, which spans multiple repositories selected for a sprint. Each
 * field contains the deduplicated, sorted union across all paths; boolean
 * flags OR across paths (true if ANY path has the file).
 *
 * Empty input returns the empty tooling object.
 */
export function detectProjectToolingAcrossPaths(projectPaths: string[]): ProjectTooling {
  if (projectPaths.length === 0) {
    return EMPTY_TOOLING;
  }

  const agents = new Set<string>();
  const skills = new Set<string>();
  const mcpServers = new Set<string>();
  let hasClaudeMd = false;
  let hasAgentsMd = false;
  let hasCopilotInstructions = false;

  for (const path of projectPaths) {
    const tooling = detectProjectTooling(path);
    for (const agent of tooling.agents) agents.add(agent);
    for (const skill of tooling.skills) skills.add(skill);
    for (const server of tooling.mcpServers) mcpServers.add(server);
    hasClaudeMd = hasClaudeMd || tooling.hasClaudeMd;
    hasAgentsMd = hasAgentsMd || tooling.hasAgentsMd;
    hasCopilotInstructions = hasCopilotInstructions || tooling.hasCopilotInstructions;
  }

  return {
    agents: [...agents].sort(),
    skills: [...skills].sort(),
    mcpServers: [...mcpServers].sort(),
    hasClaudeMd,
    hasAgentsMd,
    hasCopilotInstructions,
  };
}

/**
 * Build a rendered project tooling section from one or more project paths.
 * Accepts a single path (evaluator — one task, one repo) or an array (planner —
 * sprint may span multiple repos, union is taken).
 *
 * Returns an empty string when no tooling is detected, so consuming templates
 * can render the placeholder unconditionally.
 */
export function buildProjectToolingSection(paths: string | readonly string[]): string {
  const tooling = typeof paths === 'string' ? detectProjectTooling(paths) : detectProjectToolingAcrossPaths([...paths]);
  return renderProjectToolingSection(tooling);
}

/**
 * Render a markdown section instructing the agent how to use the detected
 * tooling. Returns an empty string when no tooling is found, so consumers can
 * substitute the result into a template placeholder unconditionally.
 *
 * The section is purposefully *prescriptive* — it tells the agent WHEN to use
 * each piece of tooling, not just that it exists. Per the article, vague
 * "you may use these tools" instructions are routinely ignored by models.
 */
export function renderProjectToolingSection(tooling: ProjectTooling): string {
  const hasAny =
    tooling.agents.length > 0 ||
    tooling.skills.length > 0 ||
    tooling.mcpServers.length > 0 ||
    tooling.hasClaudeMd ||
    tooling.hasAgentsMd ||
    tooling.hasCopilotInstructions;

  if (!hasAny) return '';

  const lines: string[] = [];
  lines.push('## Project Tooling (use these — they exist for a reason)');
  lines.push('');
  lines.push(
    'This project ships with tooling that you should prefer over generic approaches. ' +
      'Verification and evaluation must adapt to the project\u2019s actual stack and the ' +
      'agents, skills, and MCP servers it has installed.'
  );
  lines.push('');

  if (tooling.agents.length > 0) {
    lines.push('### Subagents available');
    lines.push('');
    lines.push('Delegate via the Task tool with `subagent_type=<name>` when the diff matches a specialty:');
    for (const agent of tooling.agents) {
      const hint = describeAgentHint(agent);
      lines.push(`- \`${agent}\`${hint ? ` — ${hint}` : ''}`);
    }
    lines.push('');
  }

  if (tooling.skills.length > 0) {
    lines.push('### Skills available');
    lines.push('');
    lines.push('Invoke via the Skill tool when the skill name matches the work in front of you:');
    for (const skill of tooling.skills) {
      lines.push(`- \`${skill}\``);
    }
    lines.push('');
  }

  if (tooling.mcpServers.length > 0) {
    lines.push('### MCP servers available');
    lines.push('');
    lines.push(
      'These give you tools beyond the filesystem. Use them to **interact with the running ' +
        'system**, not just read its source.'
    );
    for (const server of tooling.mcpServers) {
      const hint = describeMcpHint(server);
      lines.push(`- \`${server}\`${hint ? ` — ${hint}` : ''}`);
    }
    lines.push('');
  }

  const instructionFiles: string[] = [];
  if (tooling.hasClaudeMd) instructionFiles.push('`CLAUDE.md`');
  if (tooling.hasAgentsMd) instructionFiles.push('`AGENTS.md`');
  if (tooling.hasCopilotInstructions) instructionFiles.push('`.github/copilot-instructions.md`');

  if (instructionFiles.length > 0) {
    lines.push('### Project instructions');
    lines.push('');
    lines.push(
      `Read ${instructionFiles.join(' / ')} for project-specific verification commands, ` +
        'conventions, and constraints. If no check script is configured, derive verification ' +
        'commands from these files (e.g. `package.json` scripts referenced there).'
    );
    lines.push('');
  }

  return lines.join('\n');
}

/** Lightweight, opinionated hints for well-known subagent names. */
function describeAgentHint(name: string): string | null {
  const hints: Record<string, string> = {
    auditor: 'use for security-sensitive diffs (auth, input handling, file IO, secrets)',
    reviewer: 'use for general code-quality review of the diff',
    tester: 'use to assess test coverage and quality of new tests',
    designer: 'use for UI/UX/theming changes',
  };
  return hints[name] ?? null;
}

/** Lightweight hints for common MCP servers. */
function describeMcpHint(name: string): string | null {
  const lower = name.toLowerCase();
  if (lower.includes('playwright')) return 'use for any UI/frontend task — click through the changed flow';
  if (lower.includes('puppeteer')) return 'use for browser automation on UI changes';
  if (lower.includes('github')) return 'use to inspect related PRs/issues for context';
  if (lower.includes('postgres') || lower.includes('mysql') || lower.includes('sqlite')) {
    return 'use to verify database schema/migration changes against a real DB';
  }
  return null;
}
