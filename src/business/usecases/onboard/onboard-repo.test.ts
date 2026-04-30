import { describe, expect, it } from 'vitest';

import { Project } from '../../../domain/entities/project.ts';
import { Repository } from '../../../domain/entities/repository.ts';
import { StorageError } from '../../../domain/errors/storage-error.ts';
import type { HarnessSignal } from '../../../domain/signals/harness-signal.ts';
import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { IsoTimestamp } from '../../../domain/values/iso-timestamp.ts';
import { ProjectName } from '../../../domain/values/project-name.ts';
import { FakeAiSessionPort } from '../../_test-fakes/fake-ai-session-port.ts';
import { FakeLoggerPort } from '../../_test-fakes/fake-logger-port.ts';
import { FakePromptBuilderPort } from '../../_test-fakes/fake-prompt-builder-port.ts';
import { FakeSignalParserPort } from '../../_test-fakes/fake-signal-parser-port.ts';
import { contextFilePathFor, OnboardRepoUseCase } from './onboard-repo.ts';

const NOW = IsoTimestamp.trustString('2026-04-29T12:00:00.000Z');

function path(p: string): AbsolutePath {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function projectName(name: string): ProjectName {
  const r = ProjectName.parse(name);
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function makeRepo(p: string): Repository {
  const r = Repository.create({ path: path(p) });
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function makeProject(repos: readonly Repository[] = [makeRepo('/tmp/repo')]): Project {
  const r = Project.create({
    name: projectName('demo'),
    displayName: 'demo',
    repositories: repos,
  });
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function firstRepo(project: Project): Repository {
  const repo = project.repositories[0];
  if (repo === undefined) throw new Error('precondition failed: project has no repositories');
  return repo;
}

describe('OnboardRepoUseCase', () => {
  it('extracts all four artefacts when every onboarding signal is present', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: 'raw stdout body' } }],
    });
    const prompts = new FakePromptBuilderPort();
    const signals: readonly HarnessSignal[] = [
      { type: 'agents-md-proposal', content: '# Demo\n\nbody', timestamp: NOW },
      { type: 'setup-script', command: 'pnpm install', timestamp: NOW },
      { type: 'verify-script', command: 'pnpm typecheck && pnpm test', timestamp: NOW },
      { type: 'skill-suggestions', names: ['react-patterns', 'nextjs-app-router'], timestamp: NOW },
    ];
    const parser = new FakeSignalParserPort({ results: [signals] });
    const uc = new OnboardRepoUseCase(ai, prompts, parser, new FakeLoggerPort());

    const project = makeProject();
    const result = await uc.execute({
      project,
      repo: firstRepo(project),
      cwd: path('/tmp/repo'),
      mode: 'bootstrap',
      aiProvider: 'claude',
      projectType: 'node',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.contextFileContent).toBe('# Demo\n\nbody');
    expect(result.value.contextFilePath).toBe('CLAUDE.md');
    expect(result.value.setupScript).toBe('pnpm install');
    expect(result.value.verifyScript).toBe('pnpm typecheck && pnpm test');
    expect(result.value.skillSuggestions).toEqual(['react-patterns', 'nextjs-app-router']);
    expect(result.value.rawAiOutput).toBe('raw stdout body');
  });

  it('returns nulls / empty list when the AI emits no onboarding signals', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: 'no markers here' } }],
    });
    const prompts = new FakePromptBuilderPort();
    const parser = new FakeSignalParserPort({ results: [[]] });
    const uc = new OnboardRepoUseCase(ai, prompts, parser, new FakeLoggerPort());

    const project = makeProject();
    const result = await uc.execute({
      project,
      repo: firstRepo(project),
      cwd: path('/tmp/repo'),
      mode: 'bootstrap',
      aiProvider: 'claude',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.contextFileContent).toBeNull();
    expect(result.value.setupScript).toBeNull();
    expect(result.value.verifyScript).toBeNull();
    expect(result.value.skillSuggestions).toEqual([]);
  });

  it('targets the Copilot-native project context file when aiProvider=copilot', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: '' } }],
    });
    const prompts = new FakePromptBuilderPort();
    const parser = new FakeSignalParserPort({ results: [[]] });
    const uc = new OnboardRepoUseCase(ai, prompts, parser, new FakeLoggerPort());

    const project = makeProject();
    const result = await uc.execute({
      project,
      repo: firstRepo(project),
      cwd: path('/tmp/repo'),
      mode: 'bootstrap',
      aiProvider: 'copilot',
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.contextFilePath).toBe('.github/copilot-instructions.md');
  });

  it('threads project type + check-script suggestion + existing body to the prompt builder', async () => {
    const ai = new FakeAiSessionPort();
    const prompts = new FakePromptBuilderPort();
    const parser = new FakeSignalParserPort({ results: [[]] });
    const uc = new OnboardRepoUseCase(ai, prompts, parser, new FakeLoggerPort());

    const project = makeProject();
    await uc.execute({
      project,
      repo: firstRepo(project),
      cwd: path('/tmp/repo'),
      mode: 'update',
      aiProvider: 'claude',
      projectType: 'python',
      checkScriptSuggestion: 'pytest',
      existingAgentsMd: '# Old\n\nprior body',
    });

    expect(prompts.onboardCalls).toHaveLength(1);
    const call = prompts.onboardCalls[0];
    if (call === undefined) throw new Error('expected one onboard prompt call');
    expect(call.repoPath).toBe(path('/tmp/repo'));
    expect(call.fileName).toBe('CLAUDE.md');
    expect(call.mode).toBe('update');
    expect(call.projectType).toBe('python');
    expect(call.checkScriptSuggestion).toBe('pytest');
    expect(call.existingAgentsMd).toBe('# Old\n\nprior body');
  });

  it('falls through to "unknown" project type when the caller omits the hint', async () => {
    const ai = new FakeAiSessionPort();
    const prompts = new FakePromptBuilderPort();
    const parser = new FakeSignalParserPort({ results: [[]] });
    const uc = new OnboardRepoUseCase(ai, prompts, parser, new FakeLoggerPort());

    const project = makeProject();
    await uc.execute({
      project,
      repo: firstRepo(project),
      cwd: path('/tmp/repo'),
      mode: 'bootstrap',
      aiProvider: 'claude',
    });

    const call = prompts.onboardCalls[0];
    if (call === undefined) throw new Error('expected one onboard prompt call');
    expect(call.projectType).toBe('unknown');
  });

  it('propagates a prompt-builder StorageError without spawning the AI', async () => {
    const ai = new FakeAiSessionPort();
    const prompts = new FakePromptBuilderPort({
      failWith: new StorageError({ subCode: 'io', message: 'template missing', path: 'repo-onboard.md' }),
    });
    const parser = new FakeSignalParserPort({ results: [[]] });
    const uc = new OnboardRepoUseCase(ai, prompts, parser, new FakeLoggerPort());

    const project = makeProject();
    const result = await uc.execute({
      project,
      repo: firstRepo(project),
      cwd: path('/tmp/repo'),
      mode: 'bootstrap',
      aiProvider: 'claude',
    });

    expect(result.ok).toBe(false);
    expect(ai.captured).toHaveLength(0);
  });

  it('propagates an AI spawn error verbatim', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'error', error: new StorageError({ subCode: 'io', message: 'spawn failed' }) }],
    });
    const prompts = new FakePromptBuilderPort();
    const parser = new FakeSignalParserPort({ results: [[]] });
    const uc = new OnboardRepoUseCase(ai, prompts, parser, new FakeLoggerPort());

    const project = makeProject();
    const result = await uc.execute({
      project,
      repo: firstRepo(project),
      cwd: path('/tmp/repo'),
      mode: 'bootstrap',
      aiProvider: 'claude',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('spawn failed');
  });

  it('first-occurrence wins when the AI emits duplicate signals', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: '' } }],
    });
    const prompts = new FakePromptBuilderPort();
    const signals: readonly HarnessSignal[] = [
      { type: 'setup-script', command: 'pnpm install', timestamp: NOW },
      { type: 'setup-script', command: 'npm install', timestamp: NOW },
    ];
    const parser = new FakeSignalParserPort({ results: [signals] });
    const uc = new OnboardRepoUseCase(ai, prompts, parser, new FakeLoggerPort());

    const project = makeProject();
    const result = await uc.execute({
      project,
      repo: firstRepo(project),
      cwd: path('/tmp/repo'),
      mode: 'bootstrap',
      aiProvider: 'claude',
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.setupScript).toBe('pnpm install');
  });
});

describe('contextFilePathFor', () => {
  it('returns CLAUDE.md for claude', () => {
    expect(contextFilePathFor('claude')).toBe('CLAUDE.md');
  });

  it('returns the .github copilot path for copilot', () => {
    expect(contextFilePathFor('copilot')).toBe('.github/copilot-instructions.md');
  });
});
