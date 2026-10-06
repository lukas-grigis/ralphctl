import { describe, expect, it } from 'vitest';
import type { Repository } from '@src/domain/entity/repository.ts';
import { renderRepositoriesSection } from '@src/integration/ai/prompts/_engine/renderers/repositories.ts';
import { makeProject, makeRepository } from '@tests/fixtures/domain.ts';

const projectWith = (extra: Partial<Repository>) => makeProject({ repositories: [{ ...makeRepository(), ...extra }] });

describe('renderRepositoriesSection', () => {
  it('keeps the empty-project placeholder', () => {
    expect(renderRepositoriesSection({ ...makeProject(), repositories: [] })).toBe('_no repositories configured_');
  });

  it('renders the path bullet and no gate line when nothing is configured', () => {
    const project = makeProject();
    const out = renderRepositoriesSection(project);
    expect(out).toBe(`- \`${String(project.repositories[0]?.path)}\` (${project.repositories[0]?.name})`);
    expect(out).not.toContain('verify gate:');
  });

  it('collapses a multi-line verifyScript into one verify gate sub-bullet', () => {
    const out = renderRepositoriesSection(
      projectWith({ verifyScript: '(cd services && mvn verify)\n  &&\t(cd web-ui && check)' })
    );
    const gates = out.split('\n').filter((l) => l.includes('verify gate:'));
    expect(gates).toEqual(['  - verify gate: `(cd services && mvn verify) && (cd web-ui && check)`']);
  });

  it('renders one sub-bullet per verifyGate, with the prefix suffix only for a non-empty prefix', () => {
    const out = renderRepositoriesSection(
      projectWith({
        verifyGates: [
          { pathPrefix: 'services', command: 'mvn verify' },
          { pathPrefix: '', command: 'lint all' },
        ],
      })
    );
    expect(out).toContain(
      "  - verify gate: `mvn verify` (path: `services` — runs only when the task's diff touches it)"
    );
    expect(out).toContain('  - verify gate: `lint all`\n'.trimEnd());
    expect(out).not.toContain('`lint all` (runs');
    expect(out.split('\n').filter((l) => l.includes('verify gate:'))).toHaveLength(2);
  });

  it('lets verifyGates win over a stale verifyScript', () => {
    const out = renderRepositoriesSection(
      projectWith({ verifyScript: 'stale-script', verifyGates: [{ pathPrefix: 'a', command: 'fresh-gate' }] })
    );
    expect(out).toContain('fresh-gate');
    expect(out).not.toContain('stale-script');
  });
});
