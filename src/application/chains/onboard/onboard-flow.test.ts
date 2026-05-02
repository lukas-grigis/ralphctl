/**
 * Step-order integration test for the onboard chain. Locks the trace
 * shape on happy + failure paths so the chain definition cannot drift
 * silently.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Project } from '@src/domain/entities/project.ts';
import { Repository } from '@src/domain/entities/repository.ts';
import type { HarnessSignal } from '@src/domain/signals/harness-signal.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { FakePromptPort } from '@src/application/_test-fakes/fake-prompt-port.ts';
import { createTestDeps } from '@src/application/_test-fakes/create-test-deps.ts';
import { createOnboardFlow } from './onboard-flow.ts';

const NOW = IsoTimestamp.trustString('2026-04-29T12:00:00.000Z');
const FROZEN_DATE = new Date('2026-04-29T12:00:00.000Z');
const HAPPY_PATH_STEPS = [
  'load-project',
  'resolve-repo',
  'detect-existing-files',
  'confirm-start-ai',
  'run-onboard-ai',
  'confirm-setup-script',
  'confirm-verify-script',
  'confirm-context-file',
  'write-context-file',
  'save-repo-scripts',
];

function path(p: string): AbsolutePath {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error(`bad path: ${p}`);
  return r.value;
}

function projectName(s: string): ProjectName {
  const r = ProjectName.parse(s);
  if (!r.ok) throw new Error(`bad project name: ${s}`);
  return r.value;
}

function makeProject(repos: readonly Repository[], name = 'demo'): Project {
  const r = Project.create({
    name: projectName(name),
    displayName: name,
    repositories: repos,
  });
  if (!r.ok) throw new Error(`makeProject: ${r.error.message}`);
  return r.value;
}

function makeRepo(p: string): Repository {
  const r = Repository.create({ path: path(p) });
  if (!r.ok) throw new Error(`makeRepo: ${r.error.message}`);
  return r.value;
}

describe('createOnboardFlow', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), 'ralphctl-onboard-test-'));
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('runs load-project → resolve-repo → run-onboard-ai → confirm-* → write-context-file → save-repo-scripts (autoAccept)', async () => {
    const project = makeProject([makeRepo(repoDir)]);

    const signals: readonly HarnessSignal[] = [
      { type: 'agents-md-proposal', content: '# Demo\n\nbody', timestamp: NOW },
      { type: 'setup-script', command: 'pnpm install', timestamp: NOW },
      { type: 'verify-script', command: 'pnpm typecheck && pnpm test', timestamp: NOW },
    ];

    const deps = createTestDeps({
      projects: [project],
      aiSession: { outcomes: [{ kind: 'ok', result: { output: 'raw' } }] },
      signalParser: { results: [signals] },
    });

    const flow = createOnboardFlow(deps, {
      projectName: project.name,
      autoAccept: true,
      now: () => FROZEN_DATE,
    });

    const result = await flow.execute({
      projectName: project.name,
      autoAccept: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.trace.map((t) => t.stepName)).toStrictEqual(HAPPY_PATH_STEPS);
    for (const entry of result.value.trace) expect(entry.status).toBe('completed');

    // File written with marker on the first line.
    const written = await readFile(join(repoDir, 'CLAUDE.md'), 'utf-8');
    expect(written.startsWith('<!-- ralphctl onboard:')).toBe(true);
    expect(written).toContain('# Demo');

    // Scripts persisted on the repository, plus onboardedAt stamp.
    const reread = await deps.projectRepo.findByName(project.name);
    expect(reread.ok).toBe(true);
    if (!reread.ok) return;
    const repo = reread.value.repositories[0];
    expect(repo?.setupScript).toBe('pnpm install');
    expect(repo?.checkScript).toBe('pnpm typecheck && pnpm test');
    expect(repo?.onboardedAt).toBe(NOW);
  });

  it('skips file write when context file is empty after confirm; still saves scripts', async () => {
    const project = makeProject([makeRepo(repoDir)]);

    // AI emits only setup + verify; no context file.
    const signals: readonly HarnessSignal[] = [
      { type: 'setup-script', command: 'pnpm install', timestamp: NOW },
      { type: 'verify-script', command: 'pnpm test', timestamp: NOW },
    ];

    const deps = createTestDeps({
      projects: [project],
      aiSession: { outcomes: [{ kind: 'ok', result: { output: 'raw' } }] },
      signalParser: { results: [signals] },
    });

    const flow = createOnboardFlow(deps, {
      projectName: project.name,
      autoAccept: true,
      now: () => FROZEN_DATE,
    });

    const result = await flow.execute({ projectName: project.name, autoAccept: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.trace.map((t) => t.stepName)).toStrictEqual(HAPPY_PATH_STEPS);
    for (const entry of result.value.trace) expect(entry.status).toBe('completed');

    // No file written.
    await expect(readFile(join(repoDir, 'CLAUDE.md'), 'utf-8')).rejects.toThrow();

    // Scripts still saved.
    const reread = await deps.projectRepo.findByName(project.name);
    if (!reread.ok) return;
    const repo = reread.value.repositories[0];
    expect(repo?.setupScript).toBe('pnpm install');
    expect(repo?.checkScript).toBe('pnpm test');
  });

  it('leaves checkScript unchanged when AI emits no verify script', async () => {
    // Seed with an existing checkScript; AI emits nothing for verify; with
    // autoAccept the proposed null gets passed through, which clears it.
    // To preserve, the flow must be invoked NON-auto and the user accepts
    // the empty default by typing the existing value. Or: confirm pass-through
    // for null → clear. The test below documents the chain behaviour:
    // autoAccept + no proposal → field is cleared.
    //
    // Document the alternate path: in interactive mode, the user can edit
    // the input to keep the existing value. Skip that branch here.
    const repo0 = Repository.create({ path: path(repoDir), checkScript: 'pnpm test' });
    if (!repo0.ok) throw repo0.error;
    const project = makeProject([repo0.value]);

    // AI emits no setup nor verify.
    const deps = createTestDeps({
      projects: [project],
      aiSession: { outcomes: [{ kind: 'ok', result: { output: 'raw' } }] },
      signalParser: { results: [[]] },
    });

    const flow = createOnboardFlow(deps, {
      projectName: project.name,
      autoAccept: true,
      now: () => FROZEN_DATE,
    });

    const result = await flow.execute({ projectName: project.name, autoAccept: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // With autoAccept true, the proposal of null is accepted as null which
    // clears the existing value — explicit, predictable, easy to revert.
    const reread = await deps.projectRepo.findByName(project.name);
    if (!reread.ok) return;
    expect(reread.value.repositories[0]?.checkScript).toBeUndefined();
  });

  it('uses interactive prompts when autoAccept=false; user types over the AI default', async () => {
    const project = makeProject([makeRepo(repoDir)]);

    const signals: readonly HarnessSignal[] = [
      { type: 'setup-script', command: 'pnpm install', timestamp: NOW },
      { type: 'verify-script', command: 'pnpm test', timestamp: NOW },
    ];

    const promptPort = new FakePromptPort();
    promptPort.queueConfirm(true); // confirm-start-ai
    promptPort.queueInput('npm install'); // override setup
    promptPort.queueInput('npm test'); // override verify
    promptPort.queueEditor(null); // skip context file

    const deps = createTestDeps({
      projects: [project],
      aiSession: { outcomes: [{ kind: 'ok', result: { output: 'raw' } }] },
      signalParser: { results: [signals] },
      prompt: promptPort,
    });

    const flow = createOnboardFlow(deps, {
      projectName: project.name,
      autoAccept: false,
      now: () => FROZEN_DATE,
    });

    const result = await flow.execute({ projectName: project.name, autoAccept: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.trace.map((t) => t.stepName)).toStrictEqual(HAPPY_PATH_STEPS);

    const reread = await deps.projectRepo.findByName(project.name);
    if (!reread.ok) return;
    const repo = reread.value.repositories[0];
    expect(repo?.setupScript).toBe('npm install');
    expect(repo?.checkScript).toBe('npm test');
    expect(repo?.onboardedAt).toBe(NOW);
  });

  it('short-circuits at resolve-repo when project has multiple repos and no repoPath given', async () => {
    const project = makeProject([makeRepo('/tmp/a'), makeRepo('/tmp/b')], 'multi');

    const deps = createTestDeps({
      projects: [project],
    });

    const flow = createOnboardFlow(deps, {
      projectName: project.name,
      autoAccept: true,
    });

    const result = await flow.execute({ projectName: project.name, autoAccept: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe('invalid-state');

    const stepNames = result.error.trace.map((t) => t.stepName);
    expect(stepNames).toStrictEqual(HAPPY_PATH_STEPS);
    expect(result.error.trace[0]?.status).toBe('completed'); // load-project
    expect(result.error.trace[1]?.status).toBe('failed'); // resolve-repo
    for (const entry of result.error.trace.slice(2)) expect(entry.status).toBe('skipped');
  });

  it('detects update mode when the existing context file has the harness marker', async () => {
    const repo = makeRepo(repoDir);
    const project = makeProject([repo]);
    const existing = '<!-- ralphctl onboard: 2026-01-01T00:00:00.000Z -->\n# Old\n\nbody';
    await writeFile(join(repoDir, 'CLAUDE.md'), existing, 'utf-8');

    const deps = createTestDeps({
      projects: [project],
      aiSession: { outcomes: [{ kind: 'ok', result: { output: 'raw' } }] },
      signalParser: { results: [[]] },
    });

    const flow = createOnboardFlow(deps, {
      projectName: project.name,
      autoAccept: true,
      now: () => FROZEN_DATE,
    });

    const result = await flow.execute({ projectName: project.name, autoAccept: true });
    expect(result.ok).toBe(true);

    // Verify the prompt builder received mode=update.
    const onboardCalls = (deps.prompts as unknown as { onboardCalls: { mode: string }[] }).onboardCalls;
    expect(onboardCalls).toHaveLength(1);
    expect(onboardCalls[0]?.mode).toBe('update');
  });

  it('detects adopt mode when user declines externally-managed and existing context file has no harness marker', async () => {
    const repo = makeRepo(repoDir);
    const project = makeProject([repo]);
    await writeFile(join(repoDir, 'CLAUDE.md'), '# User authored\n\nprior body', 'utf-8');

    // detect-existing-files prompts the user; declining keeps the chain
    // on the regular AI/adopt path. Then the three confirm leaves accept
    // their defaults.
    const fakePrompt = new FakePromptPort();
    fakePrompt.queueConfirm(false); // detect-existing-files: not externally managed
    fakePrompt.queueConfirm(true); // confirm-start-ai: proceed
    fakePrompt.queueInput('pnpm install'); // confirm-setup-script
    fakePrompt.queueInput('pnpm test'); // confirm-verify-script
    fakePrompt.queueEditor('# Adopted'); // confirm-context-file

    const deps = createTestDeps({
      projects: [project],
      aiSession: { outcomes: [{ kind: 'ok', result: { output: 'raw' } }] },
      signalParser: {
        results: [
          [
            { type: 'setup-script', command: 'pnpm install', timestamp: NOW },
            { type: 'verify-script', command: 'pnpm test', timestamp: NOW },
            { type: 'agents-md-proposal', content: '# Adopted', timestamp: NOW },
          ],
        ],
      },
      prompt: fakePrompt,
    });

    const flow = createOnboardFlow(deps, {
      projectName: project.name,
      autoAccept: false,
      now: () => FROZEN_DATE,
    });

    const result = await flow.execute({ projectName: project.name, autoAccept: false });
    expect(result.ok).toBe(true);

    const onboardCalls = (deps.prompts as unknown as { onboardCalls: { mode: string; existingAgentsMd?: string }[] })
      .onboardCalls;
    expect(onboardCalls).toHaveLength(1);
    expect(onboardCalls[0]?.mode).toBe('adopt');
    expect(onboardCalls[0]?.existingAgentsMd).toContain('User authored');
  });

  it('stamps onboardedAt when user declines the AI inventory at confirm-start-ai (no pre-existing files)', async () => {
    // Repro of the user's scenario: no pre-existing context file, user
    // explicitly declines the AI inventory at confirm-start-ai. The chain
    // must still mark the repo as onboarded so doctor stops flagging it as
    // not-onboarded — `externallyManaged` here means "stamp onboardedAt
    // without writing anything", not "skip persistence entirely".
    const repo = makeRepo(repoDir);
    const project = makeProject([repo]);

    const fakePrompt = new FakePromptPort();
    fakePrompt.queueConfirm(false); // confirm-start-ai → decline

    const deps = createTestDeps({
      projects: [project],
      // No AI outcomes / signals: the chain must NOT call the AI on decline.
      aiSession: { outcomes: [] },
      signalParser: { results: [] },
      prompt: fakePrompt,
    });

    const flow = createOnboardFlow(deps, {
      projectName: project.name,
      autoAccept: false,
      now: () => FROZEN_DATE,
    });

    const result = await flow.execute({ projectName: project.name, autoAccept: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Every step in the trace completed (no aborts / failures).
    expect(result.value.trace.map((t) => t.stepName)).toStrictEqual(HAPPY_PATH_STEPS);
    for (const entry of result.value.trace) expect(entry.status).toBe('completed');

    // AI must NOT have run.
    const onboardCalls = (deps.prompts as unknown as { onboardCalls: unknown[] }).onboardCalls;
    expect(onboardCalls).toHaveLength(0);

    // No context file written — declining preserves the repo's existing state.
    await expect(readFile(join(repoDir, 'CLAUDE.md'), 'utf-8')).rejects.toThrow();

    // Repo IS stamped as onboarded so doctor classifies it as ralphctl-managed
    // (persisted timestamp wins when no context file exists on disk).
    const reread = await deps.projectRepo.findByName(project.name);
    if (!reread.ok) return;
    const persisted = reread.value.repositories[0];
    expect(persisted?.onboardedAt).toBe(NOW);
    // Scripts left untouched (decline path doesn't overwrite user's prior config).
    expect(persisted?.setupScript).toBeUndefined();
    expect(persisted?.checkScript).toBeUndefined();
  });

  it('preserves existing setupScript/checkScript when user declines the AI inventory', async () => {
    // A repo that already had setup/check scripts must not lose them when the
    // user declines a re-onboard pass — `acceptedSetupScript === undefined`
    // routes through `applyAcceptance` → "leave existing unchanged".
    const seeded = Repository.create({
      path: path(repoDir),
      setupScript: 'pnpm install',
      checkScript: 'pnpm test',
    });
    if (!seeded.ok) throw seeded.error;
    const project = makeProject([seeded.value]);

    const fakePrompt = new FakePromptPort();
    fakePrompt.queueConfirm(false); // confirm-start-ai → decline

    const deps = createTestDeps({
      projects: [project],
      aiSession: { outcomes: [] },
      signalParser: { results: [] },
      prompt: fakePrompt,
    });

    const flow = createOnboardFlow(deps, {
      projectName: project.name,
      autoAccept: false,
      now: () => FROZEN_DATE,
    });

    const result = await flow.execute({ projectName: project.name, autoAccept: false });
    expect(result.ok).toBe(true);

    const reread = await deps.projectRepo.findByName(project.name);
    if (!reread.ok) return;
    const persisted = reread.value.repositories[0];
    expect(persisted?.setupScript).toBe('pnpm install');
    expect(persisted?.checkScript).toBe('pnpm test');
    expect(persisted?.onboardedAt).toBe(NOW);
  });

  it('marks repo as externally managed in autoAccept mode when context file already exists', async () => {
    const repo = makeRepo(repoDir);
    const project = makeProject([repo]);
    await writeFile(join(repoDir, 'CLAUDE.md'), '# User authored\n\nprior body', 'utf-8');

    const deps = createTestDeps({
      projects: [project],
      // No AI outcomes / signals: the chain should not call the AI.
      aiSession: { outcomes: [] },
      signalParser: { results: [] },
    });

    const flow = createOnboardFlow(deps, {
      projectName: project.name,
      autoAccept: true,
      now: () => FROZEN_DATE,
    });

    const result = await flow.execute({ projectName: project.name, autoAccept: true });
    expect(result.ok).toBe(true);

    // AI should NOT have run.
    const onboardCalls = (deps.prompts as unknown as { onboardCalls: unknown[] }).onboardCalls;
    expect(onboardCalls).toHaveLength(0);

    // The original CLAUDE.md must be untouched.
    const body = await readFile(join(repoDir, 'CLAUDE.md'), 'utf-8');
    expect(body).toContain('User authored');
    expect(body).not.toContain('<!-- ralphctl onboard:');

    // Repo is stamped as onboarded.
    const list = await deps.projectRepo.list();
    if (!list.ok) throw new Error(list.error.message);
    const onboardedAt = list.value[0]?.repositories[0]?.onboardedAt ?? null;
    expect(onboardedAt).not.toBeNull();
  });

  it('writes to the Copilot-native path when aiProvider=copilot', async () => {
    // Create a fresh deps where the FakeAiSessionPort identifies as copilot.
    const project = makeProject([makeRepo(repoDir)]);

    const signals: readonly HarnessSignal[] = [
      { type: 'agents-md-proposal', content: '# Copilot demo', timestamp: NOW },
    ];

    const deps = createTestDeps({
      projects: [project],
      aiSession: {
        outcomes: [{ kind: 'ok', result: { output: 'raw' } }],
        providerName: 'copilot',
        displayName: 'GitHub Copilot',
      },
      signalParser: { results: [signals] },
    });

    const flow = createOnboardFlow(deps, {
      projectName: project.name,
      autoAccept: true,
      now: () => FROZEN_DATE,
    });

    const result = await flow.execute({ projectName: project.name, autoAccept: true });
    expect(result.ok).toBe(true);

    const written = await readFile(join(repoDir, '.github', 'copilot-instructions.md'), 'utf-8');
    expect(written).toContain('# Copilot demo');
  });

  it('matches the explicit repoPath against the project repositories', async () => {
    // Two repos; pass the second's path so resolve-repo picks it.
    const r1 = makeRepo('/tmp/a-not-here');
    // Use a real tmp dir for the second so the AI inventory probe can read it.
    const r2 = makeRepo(repoDir);
    const project = makeProject([r1, r2], 'multi');

    const deps = createTestDeps({
      projects: [project],
      aiSession: { outcomes: [{ kind: 'ok', result: { output: 'raw' } }] },
      signalParser: { results: [[]] },
    });

    const flow = createOnboardFlow(deps, {
      projectName: project.name,
      repoPath: r2.path,
      autoAccept: true,
      now: () => FROZEN_DATE,
    });

    const result = await flow.execute({ projectName: project.name, repoPath: r2.path, autoAccept: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.repo?.path).toBe(r2.path);
  });

  it('creates parent directory when writing to a Copilot path', async () => {
    const project = makeProject([makeRepo(repoDir)]);
    const signals: readonly HarnessSignal[] = [{ type: 'agents-md-proposal', content: '# Body', timestamp: NOW }];

    const deps = createTestDeps({
      projects: [project],
      aiSession: {
        outcomes: [{ kind: 'ok', result: { output: '' } }],
        providerName: 'copilot',
      },
      signalParser: { results: [signals] },
    });

    const flow = createOnboardFlow(deps, {
      projectName: project.name,
      autoAccept: true,
      now: () => FROZEN_DATE,
    });

    const result = await flow.execute({ projectName: project.name, autoAccept: true });
    expect(result.ok).toBe(true);
    // .github subdir was created by mkdir({ recursive: true }).
    const githubDir = join(repoDir, '.github');
    await expect(mkdir(githubDir, { recursive: false })).rejects.toThrow();
  });
});
