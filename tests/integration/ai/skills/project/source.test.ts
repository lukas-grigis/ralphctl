import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Skill } from '@src/integration/ai/skills/_engine/skill.ts';
import type { SkillSource } from '@src/integration/ai/skills/_engine/skill-source.ts';
import { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import { composeSkillSources, createProjectSkillSource } from '@src/integration/ai/skills/project/source.ts';
import { makeProject, makeRepository } from '@tests/fixtures/domain.ts';

const SETUP_BODY = 'Run pnpm install at the root.';
const VERIFY_BODY = 'Run pnpm typecheck && pnpm test.';

const fakeStaticSource = (skills: readonly Skill[]): SkillSource => ({
  async getForFlow() {
    return Result.ok(skills);
  },
});

describe('createProjectSkillSource', () => {
  it('returns an empty list when getProject yields undefined', async () => {
    const source = createProjectSkillSource({ getProject: () => undefined });
    const r = await source.getForFlow('refine');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });

  it('returns an empty list when no repository has skills set', async () => {
    const project = makeProject({ repositories: [makeRepository({ name: 'svc' })] });
    const source = createProjectSkillSource({ getProject: () => project });
    const r = await source.getForFlow('plan');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });

  it('emits one setup and one verify skill per repository that has them set, namespaced by slug', async () => {
    const a = {
      ...makeRepository({ id: RepositoryId.generate(), name: 'api', path: '/tmp/a' }),
      setupSkill: SETUP_BODY,
    };
    const b = {
      ...makeRepository({ id: RepositoryId.generate(), name: 'web-ui', path: '/tmp/b' }),
      setupSkill: SETUP_BODY,
      verifySkill: VERIFY_BODY,
    };
    const project: Project = makeProject({ repositories: [a, b] });
    const source = createProjectSkillSource({ getProject: () => project });
    const r = await source.getForFlow('implement');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(3);
    const names = r.value.map((s) => s.name);
    expect(names).toEqual([
      `ralphctl-${String(a.slug)}-setup`,
      `ralphctl-${String(b.slug)}-setup`,
      `ralphctl-${String(b.slug)}-verify`,
    ]);
    expect(r.value[0]!.content).toContain('# Setup — api');
    expect(r.value[0]!.content).toContain(SETUP_BODY);
    expect(r.value[2]!.content).toContain('# Verify — web-ui');
    expect(r.value[2]!.content).toContain(VERIFY_BODY);
  });

  it('skips empty / whitespace-only skill bodies (treats them as unset)', async () => {
    const repo = { ...makeRepository({ name: 'svc' }), setupSkill: '   \n', verifySkill: '' };
    const project = makeProject({ repositories: [repo] });
    const source = createProjectSkillSource({ getProject: () => project });
    const r = await source.getForFlow('refine');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });

  it('re-reads the project each call (closure captures the latest)', async () => {
    let current = makeProject({ repositories: [makeRepository({ name: 'svc' })] });
    const source = createProjectSkillSource({ getProject: () => current });
    const before = await source.getForFlow('refine');
    expect(before.ok && before.value).toEqual([]);

    // Simulate detect-skills writing a setupSkill onto the repo.
    current = makeProject({
      repositories: [{ ...current.repositories[0]!, setupSkill: SETUP_BODY }],
    });
    const after = await source.getForFlow('refine');
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.value).toHaveLength(1);
  });
});

describe('composeSkillSources', () => {
  it('concatenates emitted skills in source order', async () => {
    const a: Skill = { name: 'a', description: 'A description for a.', content: '' };
    const b: Skill = { name: 'b', description: 'A description for b.', content: '' };
    const composed = composeSkillSources(fakeStaticSource([a]), fakeStaticSource([b]));
    const r = await composed.getForFlow('refine');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.map((s) => s.name)).toEqual(['a', 'b']);
  });
});
