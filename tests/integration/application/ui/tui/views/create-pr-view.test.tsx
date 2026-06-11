/**
 * CreatePrView — provider-rebuild + PATH-gate regression cover.
 *
 * Two fixes guarded here:
 *  - The AI step must rebuild its provider from the `ai.createPr` settings row, NOT reuse the
 *    wire-time `deps.provider` (seeded from the `implement` row). In a mixed-provider config
 *    the latter handed the createPr *model* string to the implement *provider's* CLI.
 *  - The view must PATH-gate the AI step before firing so a missing CLI binary surfaces the
 *    actionable "binary not found" message instead of an opaque mid-run spawn failure.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type * as ProviderFactoryModule from '@src/application/bootstrap/provider-factory.ts';
import type * as DetectCliModule from '@src/integration/system/detect-cli.ts';
import type { AiProvider } from '@src/domain/entity/settings.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import { createSprintExecution, setExecutionBranch } from '@src/domain/entity/sprint-execution.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import { DEFAULT_SETTINGS, defaultAiSettingsForProvider } from '@src/business/settings/defaults.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { ENTER, tick, waitFor } from '@tests/integration/application/ui/tui/_keys.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';
import { absolutePath, makeReviewSprint } from '@tests/fixtures/domain.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';

// Capture every createAiProvider call so the test can assert the AI step rebuilt from the
// createPr row. A no-op provider is returned — the flow's PR-create leaf is stubbed below so
// the generate leaf's provider is never actually .generate()'d in the happy path either (the
// PR creator records the call before the spawn matters for these assertions).
const factoryRef = vi.hoisted(() => ({
  calls: [] as Array<{ readonly flow?: string }>,
}));
const detectRef = vi.hoisted(() => ({ installed: new Set<AiProvider>() }));

vi.mock('@src/application/bootstrap/provider-factory.ts', async () => {
  const actual = await vi.importActual<typeof ProviderFactoryModule>('@src/application/bootstrap/provider-factory.ts');
  const noopProvider: HeadlessAiProvider = {
    async generate() {
      // Never reached in these tests — the PR creator returns before the spawn output matters,
      // and the assertions key off the factory call, not a real spawn.
      return Result.ok({ signalsFile: absolutePath('/tmp/signals.json'), exitCode: 0 });
    },
  };
  return {
    ...actual,
    createAiProvider: (deps: { readonly flow?: string }) => {
      factoryRef.calls.push(deps.flow !== undefined ? { flow: deps.flow } : {});
      return noopProvider;
    },
  };
});

vi.mock('@src/integration/system/detect-cli.ts', async () => {
  const actual = await vi.importActual<typeof DetectCliModule>('@src/integration/system/detect-cli.ts');
  return {
    ...actual,
    detectInstalledProviders: async (): Promise<ReadonlySet<AiProvider>> =>
      new Set(detectRef.installed) as ReadonlySet<AiProvider>,
  };
});

// Imported AFTER the mocks above so the view picks up the mocked factory.
const { CreatePrView } = await import('@src/application/ui/tui/views/create-pr-view.tsx');

const PROJECT_ID = 'p-1' as ProjectId;
const SPRINT_ID = 's-1' as SprintId;

const makeProject = (): Project =>
  ({
    id: PROJECT_ID,
    displayName: 'Mainline',
    repositories: [{ id: 'r-1', path: absolutePath('/tmp/repo') }],
  }) as unknown as Project;

const makeExecution = (branch: string | null): SprintExecution => {
  const base = createSprintExecution({ sprintId: SPRINT_ID });
  return branch === null ? base : setExecutionBranch(base, branch);
};

const makeDeps = (overrides: Partial<AppDeps> = {}): AppDeps =>
  ({
    settings: DEFAULT_SETTINGS,
    projectRepo: {
      async findById() {
        return Result.ok(makeProject());
      },
    },
    sprintExecutionRepo: {
      async findById() {
        return Result.ok(makeExecution('feature/x'));
      },
      async save() {
        return Result.ok(undefined);
      },
    },
    storage: { dataRoot: absolutePath('/tmp/data') },
    eventBus: {
      publish() {},
      subscribe() {
        return () => {};
      },
    },
    clock: () => '2026-06-03T00:00:00.000Z',
    // Stub everything the create-pr flow leaves touch so a `return`-pressed run resolves
    // without real I/O. The PR creator returns a URL immediately. The sprint is in `review`
    // status (the create-pr leaf's allow-list) so the chain runs to completion.
    sprintRepo: {
      async findById() {
        return Result.ok(makeReviewSprint());
      },
    },
    taskRepo: {
      async findBySprintId() {
        return Result.ok([]);
      },
    },
    pullRequestCreator: async () => Result.ok({ url: 'https://x/pr/1', platform: 'github' }),
    gitRunner: {
      async run(_cwd: unknown, args: readonly string[]) {
        if (args[0] === 'rev-parse') return Result.ok({ stdout: 'feature/x\n', stderr: '', exitCode: 0 });
        return Result.ok({ stdout: '', stderr: '', exitCode: 0 });
      },
    },
    templateLoader: {
      async load() {
        return Result.ok('tmpl');
      },
    },
    writeFile: async () => Result.ok(undefined),
    logger: {
      named() {
        return this;
      },
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    // Wire-time seed keyed on implement — the view MUST NOT use this for the AI step.
    provider: {
      async generate() {
        return Result.error(new NotFoundError({ entity: 'x', id: 'y' }));
      },
    },
    ...overrides,
  }) as unknown as AppDeps;

describe('CreatePrView — provider rebuild + PATH gate', () => {
  beforeEach(() => {
    factoryRef.calls = [];
    detectRef.installed = new Set(['claude-code', 'github-copilot', 'openai-codex']);
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('rebuilds the AI provider from the createPr settings row (not the implement-seeded deps.provider)', async () => {
    // Mixed config: createPr on github-copilot. The factory must be invoked with flow:createPr.
    const settings = {
      ...DEFAULT_SETTINGS,
      ai: { ...DEFAULT_SETTINGS.ai, createPr: defaultAiSettingsForProvider('github-copilot').createPr },
    };
    const deps = makeDeps({ settings });
    const { result } = renderView(<CreatePrView />, {
      deps,
      initial: { id: 'create-pr' },
      selection: { projectId: PROJECT_ID, sprintId: SPRINT_ID },
    });
    await waitForViewReady(result, (f) => f.includes('Confirm'));

    result.stdin.write(ENTER);
    await waitFor(() => factoryRef.calls.map((c) => c.flow).includes('createPr'));

    expect(factoryRef.calls.map((c) => c.flow)).toContain('createPr');
  });

  it('fires the PATH gate when the createPr provider CLI is not installed', async () => {
    detectRef.installed = new Set(['claude-code']); // copilot missing
    const settings = {
      ...DEFAULT_SETTINGS,
      ai: { ...DEFAULT_SETTINGS.ai, createPr: defaultAiSettingsForProvider('github-copilot').createPr },
    };
    const deps = makeDeps({ settings });
    const { result } = renderView(<CreatePrView />, {
      deps,
      initial: { id: 'create-pr' },
      selection: { projectId: PROJECT_ID, sprintId: SPRINT_ID },
    });
    await waitForViewReady(result, (f) => f.includes('Confirm'));

    result.stdin.write(ENTER);
    await waitFor(() => (result.lastFrame() ?? '').includes('copilot'));

    const frame = result.lastFrame() ?? '';
    // The gate's actionable message names the binary + the settings key — surfaced as the
    // view's error state, not an opaque spawn failure.
    expect(frame).toContain('copilot');
    expect(frame).toContain('ai.createPr.provider');
    // The gate fired BEFORE the provider was built — no factory call when the binary is absent.
    expect(factoryRef.calls).toHaveLength(0);
  });

  it('does not PATH-gate when AI authoring is toggled off, even with no provider CLI installed', async () => {
    detectRef.installed = new Set(); // nothing installed — proves the gate is skipped for useAi=false
    const deps = makeDeps();
    const { result } = renderView(<CreatePrView />, {
      deps,
      initial: { id: 'create-pr' },
      selection: { projectId: PROJECT_ID, sprintId: SPRINT_ID },
    });
    await waitForViewReady(result, (f) => f.includes('Confirm'));

    // Toggle AI off, then run.
    result.stdin.write('a');
    await tick(40);
    result.stdin.write(ENTER);
    await tick(120);

    // The PATH gate did NOT fire — the template path spawns no AI even with nothing installed.
    const frame = result.lastFrame() ?? '';
    expect(frame).not.toContain('not on PATH');
    // Any provider the view did construct is keyed on the createPr row — never the
    // implement-seeded wire-time provider.
    expect(factoryRef.calls.every((c) => c.flow === 'createPr')).toBe(true);
  });
});
