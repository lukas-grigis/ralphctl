import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project } from '@src/domain/models.ts';
import { ProjectNotFoundError } from '@src/domain/errors.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { LoggerPort, SpinnerHandle } from '@src/business/ports/logger.ts';
import type { PromptPort } from '@src/business/ports/prompt.ts';
import type { OnboardAdapterPort } from '@src/business/ports/onboard-adapter.ts';
import { executePipeline } from '@src/business/pipelines/framework/pipeline.ts';
import { createOnboardPipeline, type OnboardContext, type OnboardDeps } from './onboard.ts';

function makeSpinner(): SpinnerHandle {
  return {
    succeed: () => {
      /* noop */
    },
    fail: () => {
      /* noop */
    },
    stop: () => {
      /* noop */
    },
  };
}

function makeLogger(): LoggerPort {
  const noop = () => {
    /* noop */
  };
  const l: LoggerPort = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    success: noop,
    warning: noop,
    tip: noop,
    header: noop,
    separator: noop,
    field: noop,
    card: noop,
    newline: noop,
    dim: noop,
    item: noop,
    spinner: () => makeSpinner(),
    child: () => l,
    time: () => () => {
      /* noop */
    },
  };
  return l;
}

function makePrompt(): PromptPort {
  return {
    select: () => {
      throw new Error('unexpected select');
    },
    confirm: () => Promise.resolve(true),
    input: () => Promise.resolve(''),
    checkbox: () => Promise.resolve([]),
    editor: (opts) => Promise.resolve(opts.default ?? ''),
    fileBrowser: () => Promise.resolve(null),
  };
}

function makePersistence(project: Project): PersistencePort {
  const stub = {} as PersistencePort;
  return {
    ...stub,
    getProject: (name: string) => {
      if (name === project.name) return Promise.resolve(project);
      return Promise.reject(new ProjectNotFoundError(name));
    },
    getConfig: () =>
      Promise.resolve({
        currentSprint: null,
        aiProvider: 'claude' as const,
        editor: null,
      }),
  };
}

function makeAdapter(agentsMd: string, checkScript: string): OnboardAdapterPort {
  return {
    readExistingInstructions: () => ({ content: null, authored: false }),
    validateRepoPath: () => ({ exists: true, isGitRepo: true }),
    lintAgentsMd: () => ({ ok: true, violations: [] }),
    detectCommandDrift: () => [],
    discoverAgentsMd: () => Promise.resolve({ agentsMd, checkScript, changes: null }),
    inferProjectType: () => 'node',
    writeProviderInstructions: (repoPath) => ({ path: join(repoPath, 'CLAUDE.md') }),
  };
}

function makeDeps(project: Project, adapter: OnboardAdapterPort): OnboardDeps {
  return {
    persistence: makePersistence(project),
    adapter,
    logger: makeLogger(),
    prompt: makePrompt(),
    updateProjectRepos: (_name, repositories) => Promise.resolve({ ...project, repositories }),
  };
}

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'onboard-'));
  mkdirSync(join(dir, '.git'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
  return dir;
}

const VALID_AGENTS_MD = '# Project\n\n## Build\n\nrun it.\n';

describe('createOnboardPipeline', () => {
  it('fails fast when the project is unknown', async () => {
    const project: Project = {
      id: 'p1',
      name: 'known',
      displayName: 'Known',
      repositories: [{ id: 'r1', name: 'r', path: '/tmp/nope' }],
    };
    const deps = makeDeps(project, makeAdapter(VALID_AGENTS_MD, ''));
    const pipeline = createOnboardPipeline(deps, {});
    const ctx: OnboardContext = { sprintId: '', projectName: 'unknown' };
    const result = await executePipeline(pipeline, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.message).toContain('load-project');
  });

  it('runs the full step order on the happy path (auto + dry-run)', async () => {
    const repoPath = makeGitRepo();
    try {
      const project: Project = {
        id: 'p1',
        name: 'demo',
        displayName: 'Demo',
        repositories: [{ id: 'r1', name: 'demo-repo', path: repoPath }],
      };
      const deps = makeDeps(project, makeAdapter(VALID_AGENTS_MD, 'pnpm test'));
      const pipeline = createOnboardPipeline(deps, { auto: true, dryRun: true });
      const ctx: OnboardContext = { sprintId: '', projectName: 'demo' };
      const result = await executePipeline(pipeline, ctx);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const stepNames = result.value.stepResults.map((r) => r.stepName);
      expect(stepNames).toEqual([
        'load-project',
        'select-repo',
        'repo-preflight',
        'ai-inventory',
        'validate-agents-md',
        'retry-agents-md-on-violation',
        'check-drift',
        'review-and-confirm',
        'write-artifacts',
        'verify-check-script',
      ]);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('writes provider-native project context file on non-dry-run happy path', async () => {
    const repoPath = makeGitRepo();
    try {
      const project: Project = {
        id: 'p1',
        name: 'demo',
        displayName: 'Demo',
        repositories: [{ id: 'r1', name: 'demo-repo', path: repoPath }],
      };
      const writeArgs: { path: string; content: string; provider: string }[] = [];
      const adapter: OnboardAdapterPort = {
        ...makeAdapter(VALID_AGENTS_MD, 'pnpm test'),
        writeProviderInstructions: (p, content, provider) => {
          writeArgs.push({ path: p, content, provider });
          return { path: join(p, 'CLAUDE.md') };
        },
      };
      const deps = makeDeps(project, adapter);
      const pipeline = createOnboardPipeline(deps, { auto: true });
      const ctx: OnboardContext = { sprintId: '', projectName: 'demo' };
      const result = await executePipeline(pipeline, ctx);

      expect(result.ok).toBe(true);
      expect(writeArgs).toHaveLength(1);
      expect(writeArgs[0]?.path).toBe(repoPath);
      expect(writeArgs[0]?.content).toBe(VALID_AGENTS_MD);
      expect(writeArgs[0]?.provider).toBe('claude');
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('halts when AI inventory returns no project context file proposal', async () => {
    const repoPath = makeGitRepo();
    try {
      const project: Project = {
        id: 'p1',
        name: 'demo',
        displayName: 'Demo',
        repositories: [{ id: 'r1', name: 'demo-repo', path: repoPath }],
      };
      const adapter: OnboardAdapterPort = {
        ...makeAdapter('', ''),
        discoverAgentsMd: () => Promise.resolve({ agentsMd: null, checkScript: null, changes: null }),
      };
      const deps = makeDeps(project, adapter);
      const pipeline = createOnboardPipeline(deps, { auto: true, dryRun: true });
      const ctx: OnboardContext = { sprintId: '', projectName: 'demo' };
      const result = await executePipeline(pipeline, ctx);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('ai-inventory');
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
