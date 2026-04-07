import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectProjectTooling, renderProjectToolingSection } from './project-tooling.ts';

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'ralphctl-tooling-test-'));
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

describe('detectProjectTooling', () => {
  it('returns empty tooling for an empty project', () => {
    const tooling = detectProjectTooling(projectDir);
    expect(tooling.agents).toEqual([]);
    expect(tooling.skills).toEqual([]);
    expect(tooling.mcpServers).toEqual([]);
    expect(tooling.hasClaudeMd).toBe(false);
    expect(tooling.hasAgentsMd).toBe(false);
    expect(tooling.hasCopilotInstructions).toBe(false);
  });

  it('returns empty tooling when projectPath does not exist', () => {
    const tooling = detectProjectTooling('/this/path/does/not/exist/abc123');
    expect(tooling.agents).toEqual([]);
    expect(tooling.skills).toEqual([]);
  });

  it('detects subagents in .claude/agents/*.md', async () => {
    const agentsDir = join(projectDir, '.claude', 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, 'reviewer.md'), '# reviewer');
    await writeFile(join(agentsDir, 'auditor.md'), '# auditor');
    await writeFile(join(agentsDir, 'README.txt'), 'not a markdown agent');

    const tooling = detectProjectTooling(projectDir);
    expect(tooling.agents).toEqual(['auditor', 'reviewer']); // sorted, .md stripped, .txt ignored
  });

  it('detects skills as subdirectories of .claude/skills/', async () => {
    const skillsDir = join(projectDir, '.claude', 'skills');
    await mkdir(join(skillsDir, 'code-review'), { recursive: true });
    await mkdir(join(skillsDir, 'simplify'), { recursive: true });
    await writeFile(join(skillsDir, 'NOT-A-SKILL.md'), 'loose file');

    const tooling = detectProjectTooling(projectDir);
    expect(tooling.skills).toEqual(['code-review', 'simplify']);
  });

  it('detects MCP servers from .mcp.json', async () => {
    const mcpConfig = {
      mcpServers: {
        playwright: { command: 'npx', args: ['@playwright/mcp'] },
        github: { command: 'npx', args: ['@github/mcp'] },
      },
    };
    await writeFile(join(projectDir, '.mcp.json'), JSON.stringify(mcpConfig));

    const tooling = detectProjectTooling(projectDir);
    expect(tooling.mcpServers).toEqual(['github', 'playwright']); // sorted
  });

  it('returns empty mcpServers when .mcp.json is malformed', async () => {
    await writeFile(join(projectDir, '.mcp.json'), 'not json');
    const tooling = detectProjectTooling(projectDir);
    expect(tooling.mcpServers).toEqual([]);
  });

  it('detects CLAUDE.md, AGENTS.md, and copilot-instructions.md', async () => {
    await writeFile(join(projectDir, 'CLAUDE.md'), '# Claude');
    await writeFile(join(projectDir, 'AGENTS.md'), '# Agents');
    await mkdir(join(projectDir, '.github'), { recursive: true });
    await writeFile(join(projectDir, '.github', 'copilot-instructions.md'), '# copilot');

    const tooling = detectProjectTooling(projectDir);
    expect(tooling.hasClaudeMd).toBe(true);
    expect(tooling.hasAgentsMd).toBe(true);
    expect(tooling.hasCopilotInstructions).toBe(true);
  });
});

describe('renderProjectToolingSection', () => {
  it('returns empty string when nothing is detected', () => {
    const tooling = detectProjectTooling(projectDir);
    expect(renderProjectToolingSection(tooling)).toBe('');
  });

  it('renders an agents section with hints for known agents', async () => {
    const agentsDir = join(projectDir, '.claude', 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, 'auditor.md'), '');
    await writeFile(join(agentsDir, 'custom-thing.md'), '');

    const section = renderProjectToolingSection(detectProjectTooling(projectDir));
    expect(section).toContain('## Project Tooling');
    expect(section).toContain('### Subagents available');
    expect(section).toContain('`auditor`');
    expect(section).toContain('security-sensitive');
    expect(section).toContain('`custom-thing`'); // unknown agents still listed
  });

  it('renders an MCP section with hints for playwright', async () => {
    await writeFile(join(projectDir, '.mcp.json'), JSON.stringify({ mcpServers: { 'playwright-mcp': {} } }));
    const section = renderProjectToolingSection(detectProjectTooling(projectDir));
    expect(section).toContain('### MCP servers available');
    expect(section).toContain('`playwright-mcp`');
    expect(section).toContain('UI/frontend');
  });

  it('renders an instructions section listing only the files that exist', async () => {
    await writeFile(join(projectDir, 'CLAUDE.md'), '');
    const section = renderProjectToolingSection(detectProjectTooling(projectDir));
    expect(section).toContain('### Project instructions');
    expect(section).toContain('`CLAUDE.md`');
    expect(section).not.toContain('`AGENTS.md`');
  });
});
