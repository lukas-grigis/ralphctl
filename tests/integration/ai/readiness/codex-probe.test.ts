import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexProbe } from '@src/integration/ai/readiness/codex/probe.ts';
import { absolutePath, FIXED_NOW, makeRepository } from '@tests/fixtures/domain.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import { isAbsent, isPresent } from '@src/integration/ai/readiness/_engine/predicates.ts';

const repoAt = (path: string): Repository => makeRepository({ path, name: 'tmp', slug: 'tmp' });

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'ralphctl-codex-probe-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('codexProbe', () => {
  it('returns absent for an empty repo', async () => {
    const r = await codexProbe.evaluate(repoAt(dir), FIXED_NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(isAbsent(r.value)).toBe(true);
  });

  it('returns present when AGENTS.md exists', async () => {
    await fs.writeFile(join(dir, 'AGENTS.md'), '# project context\n');
    const r = await codexProbe.evaluate(repoAt(dir), FIXED_NOW);
    expect(r.ok).toBe(true);
    if (!r.ok || !isPresent(r.value) || r.value.artifacts.tool !== 'codex') throw new Error('expected present');
    expect(r.value.artifacts.agentsMd?.path).toBe(absolutePath(join(dir, 'AGENTS.md')));
  });

  it('discovers .agents/skills/<name>/SKILL.md folders', async () => {
    await fs.mkdir(join(dir, '.agents/skills/my-skill'), { recursive: true });
    await fs.writeFile(join(dir, '.agents/skills/my-skill/SKILL.md'), 'skill body');
    const r = await codexProbe.evaluate(repoAt(dir), FIXED_NOW);
    expect(r.ok).toBe(true);
    if (!r.ok || !isPresent(r.value) || r.value.artifacts.tool !== 'codex') throw new Error('expected present');
    expect(r.value.artifacts.skills).toHaveLength(1);
    expect(r.value.artifacts.skills[0]?.name).toBe('my-skill');
    expect(r.value.artifacts.skills[0]?.path).toBe(absolutePath(join(dir, '.agents/skills/my-skill/SKILL.md')));
  });
});
