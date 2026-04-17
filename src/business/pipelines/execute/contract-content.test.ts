import { describe, expect, it } from 'vitest';
import type { Task } from '@src/domain/models.ts';
import { buildContractMarkdown, EVALUATOR_DIMENSIONS } from './contract-content.ts';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    name: 'Add null check',
    description: 'Prevent NPE in the request handler.',
    steps: ['Read existing handler', 'Add guard clause', 'Add unit test'],
    verificationCriteria: ['Handler rejects null input', 'Test passes'],
    status: 'todo',
    order: 1,
    blockedBy: [],
    repoId: 'repo-1',
    verified: false,
    evaluated: false,
    ...overrides,
  };
}

describe('buildContractMarkdown', () => {
  it('includes task name, description, steps, and verification criteria', () => {
    const md = buildContractMarkdown({ task: task(), repoPath: '/repo', checkScript: 'pnpm test' });

    expect(md).toContain('Sprint Contract — Add null check');
    expect(md).toContain('Prevent NPE in the request handler.');
    expect(md).toContain('1. Read existing handler');
    expect(md).toContain('2. Add guard clause');
    expect(md).toContain('- [ ] Handler rejects null input');
    expect(md).toContain('- [ ] Test passes');
  });

  it('fences the resolved check script and notes it is the gate', () => {
    const md = buildContractMarkdown({ task: task(), repoPath: '/repo', checkScript: 'pnpm typecheck && pnpm test' });

    expect(md).toContain('```sh\npnpm typecheck && pnpm test\n```');
    expect(md).toContain('deterministic gate');
  });

  it('explains the fallback path when no check script is configured', () => {
    const md = buildContractMarkdown({ task: task(), repoPath: '/repo', checkScript: null });

    expect(md).toContain('no check script configured');
    expect(md).toContain('CLAUDE.md');
    expect(md).toContain('package.json');
    expect(md).not.toContain('```sh');
  });

  it('lists the four evaluator dimensions by default', () => {
    const md = buildContractMarkdown({ task: task(), repoPath: '/repo', checkScript: null });

    for (const dim of EVALUATOR_DIMENSIONS) {
      expect(md).toContain(`- **${dim}**`);
    }
  });

  it('honours custom evaluator dimensions when supplied', () => {
    const md = buildContractMarkdown({
      task: task(),
      repoPath: '/repo',
      checkScript: null,
      evaluatorDimensions: ['Performance', 'DX'],
    });

    expect(md).toContain('- **Performance**');
    expect(md).toContain('- **DX**');
    expect(md).not.toContain('- **Correctness**');
  });

  it('handles tasks with no steps', () => {
    const md = buildContractMarkdown({
      task: task({ steps: [] }),
      repoPath: '/repo',
      checkScript: null,
    });

    // Steps section is absent when steps is empty — avoids numbered-list gaps.
    expect(md).not.toContain('## Steps');
  });

  it('handles tasks with no verification criteria with a placeholder line', () => {
    const md = buildContractMarkdown({
      task: task({ verificationCriteria: [] }),
      repoPath: '/repo',
      checkScript: 'pnpm test',
    });

    expect(md).toContain('## Verification Criteria');
    expect(md).toContain('none declared');
  });

  it('handles tasks with no description', () => {
    const md = buildContractMarkdown({
      task: task({ description: undefined }),
      repoPath: '/repo',
      checkScript: null,
    });

    expect(md).toContain('Sprint Contract — Add null check');
    // Description is absent — no broken section reference.
    expect(md).not.toContain('**Description:**');
  });

  it('includes the project path', () => {
    const md = buildContractMarkdown({
      task: task(),
      repoPath: '/workspace/repo',
      checkScript: null,
    });
    expect(md).toContain('`/workspace/repo`');
  });
});
