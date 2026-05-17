import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeProbe } from '@src/integration/ai/readiness/claude/probe.ts';
import { absolutePath, FIXED_NOW, makeRepository } from '@tests/fixtures/domain.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import { isAbsent, isPresent } from '@src/integration/ai/readiness/_engine/predicates.ts';

const mkdtemp = () => fs.mkdtemp(join(tmpdir(), 'ralphctl-claude-probe-'));

const repoAt = (path: string): Repository => makeRepository({ path, name: 'tmp', slug: 'tmp' });

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('claudeProbe', () => {
  it('returns absent for an empty repo', async () => {
    const r = await claudeProbe.evaluate(repoAt(dir), FIXED_NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(isAbsent(r.value)).toBe(true);
  });

  it('returns present with CLAUDE.md', async () => {
    await fs.writeFile(join(dir, 'CLAUDE.md'), '# project memory\n');
    const r = await claudeProbe.evaluate(repoAt(dir), FIXED_NOW);
    expect(r.ok).toBe(true);
    if (!r.ok || !isPresent(r.value)) throw new Error('expected present');
    expect(r.value.artifacts.tool).toBe('claude-code');
    if (r.value.artifacts.tool !== 'claude-code') return;
    expect(r.value.artifacts.claudeMd?.path).toBe(absolutePath(join(dir, 'CLAUDE.md')));
  });

  it('discovers skills, commands, and subagents in .claude/', async () => {
    await fs.mkdir(join(dir, '.claude/skills/my-skill'), { recursive: true });
    await fs.writeFile(join(dir, '.claude/skills/my-skill/SKILL.md'), 'skill body');
    await fs.mkdir(join(dir, '.claude/commands'), { recursive: true });
    await fs.writeFile(join(dir, '.claude/commands/deploy.md'), 'cmd body');
    await fs.mkdir(join(dir, '.claude/agents'), { recursive: true });
    await fs.writeFile(join(dir, '.claude/agents/helper.md'), 'agent body');

    const r = await claudeProbe.evaluate(repoAt(dir), FIXED_NOW);
    expect(r.ok).toBe(true);
    if (!r.ok || !isPresent(r.value) || r.value.artifacts.tool !== 'claude-code') {
      throw new Error('expected present with claude artifacts');
    }
    const artifacts = r.value.artifacts;
    expect(artifacts.skills).toHaveLength(1);
    expect(artifacts.skills[0]?.name).toBe('my-skill');
    expect(artifacts.commands).toHaveLength(1);
    expect(artifacts.commands[0]?.name).toBe('deploy');
    expect(artifacts.agents).toHaveLength(1);
    expect(artifacts.agents[0]?.name).toBe('helper');
  });

  it('extracts hooks from .claude/settings.json', async () => {
    await fs.mkdir(join(dir, '.claude'), { recursive: true });
    const settings = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/audit-bash.sh' }] }],
      },
    };
    await fs.writeFile(join(dir, '.claude/settings.json'), JSON.stringify(settings));

    const r = await claudeProbe.evaluate(repoAt(dir), FIXED_NOW);
    expect(r.ok).toBe(true);
    if (!r.ok || !isPresent(r.value) || r.value.artifacts.tool !== 'claude-code') {
      throw new Error('expected present');
    }
    const artifacts = r.value.artifacts;
    expect(artifacts.hooks).toHaveLength(1);
    expect(artifacts.hooks[0]?.event).toBe('PreToolUse');
    expect(artifacts.hooks[0]?.script).toBe('/usr/local/bin/audit-bash.sh');
  });

  it('returns ProbeError when settings.json is malformed', async () => {
    await fs.mkdir(join(dir, '.claude'), { recursive: true });
    await fs.writeFile(join(dir, '.claude/settings.json'), '{ not json');
    const r = await claudeProbe.evaluate(repoAt(dir), FIXED_NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.subCode).toBe('malformed');
  });
});
