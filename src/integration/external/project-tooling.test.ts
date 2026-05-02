import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { detectProjectTooling } from './project-tooling.ts';

function uniqueDir(label: string): string {
  return join(
    tmpdir(),
    `ralphctl-tooling-${label}-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`
  );
}

describe('detectProjectTooling', () => {
  const created: string[] = [];

  beforeEach(() => {
    created.length = 0;
  });

  afterEach(async () => {
    for (const dir of created) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function makeDir(label: string): Promise<AbsolutePath> {
    const dir = uniqueDir(label);
    await mkdir(dir, { recursive: true });
    created.push(dir);
    return AbsolutePath.trustString(dir);
  }

  it('returns the empty shape when called with no paths', async () => {
    const r = await detectProjectTooling([]);
    expect(r.hasClaude).toBe(false);
    expect(r.hasCopilot).toBe(false);
    expect(r.hasCustomAgents).toBe(false);
    expect(r.hasSkills).toBe(false);
    expect(r.hasMcp).toBe(false);
    expect(r.rendered).toBe('');
  });

  it('returns the empty shape when no tooling is present', async () => {
    const dir = await makeDir('empty');
    const r = await detectProjectTooling([dir]);
    expect(r.hasClaude).toBe(false);
    expect(r.hasCopilot).toBe(false);
    expect(r.hasCustomAgents).toBe(false);
    expect(r.hasSkills).toBe(false);
    expect(r.hasMcp).toBe(false);
    expect(r.rendered).toBe('');
  });

  it('detects Claude + Copilot project context files', async () => {
    const dir = await makeDir('claude-copilot');
    await writeFile(join(dir, 'CLAUDE.md'), '# project');
    await mkdir(join(dir, '.github'), { recursive: true });
    await writeFile(join(dir, '.github', 'copilot-instructions.md'), '# copilot');

    const r = await detectProjectTooling([dir]);
    expect(r.hasClaude).toBe(true);
    expect(r.hasCopilot).toBe(true);
    expect(r.rendered).toContain('CLAUDE.md');
    expect(r.rendered).toContain('copilot-instructions.md');
    expect(r.rendered.startsWith('## Project Tooling')).toBe(true);
  });

  it('treats empty .claude/agents and .claude/skills directories as absent', async () => {
    const dir = await makeDir('empty-agents');
    await mkdir(join(dir, '.claude', 'agents'), { recursive: true });
    await mkdir(join(dir, '.claude', 'skills'), { recursive: true });

    const r = await detectProjectTooling([dir]);
    expect(r.hasCustomAgents).toBe(false);
    expect(r.hasSkills).toBe(false);
  });

  it('detects non-empty agents/skills directories and the .mcp.json marker', async () => {
    const dir = await makeDir('agents-skills-mcp');
    await mkdir(join(dir, '.claude', 'agents'), { recursive: true });
    await writeFile(join(dir, '.claude', 'agents', 'reviewer.md'), '# reviewer');
    await mkdir(join(dir, '.claude', 'skills'), { recursive: true });
    await writeFile(join(dir, '.claude', 'skills', 'alignment.md'), '# alignment');
    await writeFile(join(dir, '.mcp.json'), '{}');

    const r = await detectProjectTooling([dir]);
    expect(r.hasCustomAgents).toBe(true);
    expect(r.hasSkills).toBe(true);
    expect(r.hasMcp).toBe(true);
    expect(r.rendered).toContain('.claude/agents');
    expect(r.rendered).toContain('.claude/skills');
    expect(r.rendered).toContain('.mcp.json');
  });

  it('unions tooling across multiple repo paths', async () => {
    const a = await makeDir('union-a');
    const b = await makeDir('union-b');
    await writeFile(join(a, 'CLAUDE.md'), '# a');
    await writeFile(join(b, '.mcp.json'), '{}');

    const r = await detectProjectTooling([a, b]);
    expect(r.hasClaude).toBe(true);
    expect(r.hasMcp).toBe(true);
    expect(r.hasCopilot).toBe(false);
    expect(r.rendered).toContain('CLAUDE.md');
    expect(r.rendered).toContain('.mcp.json');
  });
});
