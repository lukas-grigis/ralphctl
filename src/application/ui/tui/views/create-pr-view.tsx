/**
 * Create-pull-request view — opens a PR / MR for the selected sprint's branch via the configured platform CLI (`gh` /
 * `glab`).
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useViewKeys } from '@src/application/ui/tui/runtime/use-view-keys.ts';
import { glyphs, inkColors, spacing, tones } from '@src/application/ui/tui/theme/tokens.ts';
import { createCreatePrFlow } from '@src/application/flows/create-pr/flow.ts';
import { resolveEffort } from '@src/business/settings/resolve-effort.ts';
import { createAiProvider } from '@src/application/bootstrap/provider-factory.ts';
import { createSkillsAdapter } from '@src/integration/ai/skills/adapter-factory.ts';
import { buildComposedSkillSource } from '@src/application/ui/shared/launcher.ts';
import { checkCli } from '@src/application/ui/shared/launch/check-cli.ts';
import { resolveSprintDir } from '@src/integration/persistence/storage.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { Result } from '@src/domain/result.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';

const DEFAULT_BASE = 'main';
const DEFAULT_DRAFT = false;

type PrepState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly cwd: AbsolutePath; readonly branch: string }
  | { readonly kind: 'error'; readonly message: string };

type RunState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running' }
  | { readonly kind: 'done'; readonly url: string }
  | { readonly kind: 'error'; readonly message: string };

export const CreatePrView = (): React.JSX.Element => {
  const deps = useDeps();
  const selection = useSelection();
  const [prep, setPrep] = useState<PrepState>({ kind: 'loading' });
  const [run, setRun] = useState<RunState>({ kind: 'idle' });
  const [useAi, setUseAi] = useState<boolean>(true);
  // Resolve cwd (project's first repo path) and branch (sprint-execution.branch) up front,
  // so the confirm card can show concrete values rather than spinning twice.
  useEffect(() => {
    // Guard the setPrep write behind a `cancelled` flag: if the selection changes (a new load starts) or the view
    // unmounts while `resolvePrepState`'s awaits are in flight.
    let cancelled = false;
    void resolvePrepState(deps, selection.projectId, selection.sprintId).then((next) => {
      if (!cancelled) setPrep(next);
    });
    return () => {
      cancelled = true;
    };
  }, [deps, selection.projectId, selection.sprintId]);

  const runCreate = useCallback(
    async (cwd: AbsolutePath): Promise<void> => {
      const inputs = await resolveCreatePrInputs(deps, selection.sprintId, useAi);
      if (!inputs.ok) {
        setRun(inputs.error);
        return;
      }
      setRun({ kind: 'running' });
      setRun(
        await executeCreatePrFlow({
          deps,
          sprintId: selection.sprintId!,
          sprintDir: inputs.value.sprintDir,
          cwd,
          useAi,
        })
      );
    },
    [deps, selection.sprintId, useAi]
  );

  const canConfirm = prep.kind === 'ready' && run.kind === 'idle';
  useViewKeys([
    {
      keys: ['↵'],
      hint: 'open PR',
      enabled: canConfirm,
      run: () => {
        if (prep.kind === 'ready') void runCreate(prep.cwd);
      },
    },
    { keys: ['a'], hint: 'toggle AI', enabled: canConfirm, run: () => setUseAi((prev) => !prev) },
    {
      keys: ['r'],
      hint: 'retry',
      enabled: run.kind === 'error',
      // Back to the confirm card (re-enabling the `a` toggle) rather than re-firing directly —
      // this view creates an upstream PR, so every attempt goes through the explicit Enter.
      run: () => setRun({ kind: 'idle' }),
    },
    { keys: ['esc'], hint: 'back' },
  ]);

  return (
    <ViewShell title="Create pull request" subtitle="open PR / MR for the sprint branch">
      <Body prep={prep} run={run} useAi={useAi} />
    </ViewShell>
  );
};

/**
 * Resolve the confirm card's inputs: the project's first repo path (`cwd`) and the sprint execution's branch.
 */
const resolvePrepState = async (
  deps: AppDeps,
  projectId: ProjectId | undefined,
  sprintId: SprintId | undefined
): Promise<PrepState> => {
  if (projectId === undefined || sprintId === undefined) {
    return { kind: 'error', message: 'No project or sprint selected.' };
  }
  const project = await deps.projectRepo.findById(projectId);
  if (!project.ok) return { kind: 'error', message: project.error.message };
  const cwd = project.value.repositories[0]?.path;
  if (cwd === undefined) {
    return { kind: 'error', message: 'Project has no repositories — add one first.' };
  }
  const execution = await deps.sprintExecutionRepo.findById(sprintId);
  if (!execution.ok) return { kind: 'error', message: execution.error.message };
  if (execution.value.branch === null) {
    return { kind: 'error', message: 'Sprint has no branch — implement at least one task first.' };
  }
  return { kind: 'ready', cwd, branch: execution.value.branch };
};

/**
 * Guard chain for the `runCreate` handler: sprint-selected check, then the PATH gate for the AI step, then the
 * sprint-dir resolve + parse.
 */
const resolveCreatePrInputs = async (
  deps: AppDeps,
  sprintId: SprintId | undefined,
  useAi: boolean
): Promise<Result<{ readonly sprintDir: AbsolutePath }, RunState>> => {
  if (sprintId === undefined) {
    return Result.error({ kind: 'error', message: 'No sprint selected.' });
  }
  if (useAi) {
    const gate = await checkCli('create-pr', deps.settings);
    if (gate !== undefined && !gate.ok) {
      return Result.error({ kind: 'error', message: gate.reason });
    }
  }
  const resolvedDir = await resolveSprintDir(deps.storage.dataRoot, sprintId);
  if (resolvedDir === undefined) {
    return Result.error({ kind: 'error', message: 'sprint dir: not found on disk' });
  }
  const sprintDir = AbsolutePath.parse(resolvedDir);
  if (!sprintDir.ok) {
    return Result.error({ kind: 'error', message: `sprint dir: ${sprintDir.error.message}` });
  }
  return Result.ok({ sprintDir: sprintDir.value });
};

interface ExecuteCreatePrFlowArgs {
  readonly deps: AppDeps;
  readonly sprintId: SprintId;
  readonly sprintDir: AbsolutePath;
  readonly cwd: AbsolutePath;
  readonly useAi: boolean;
}

/** Build the createPr provider + flow and run it. */
const executeCreatePrFlow = async (args: ExecuteCreatePrFlowArgs): Promise<RunState> => {
  const { deps, sprintId, sprintDir, cwd, useAi } = args;
  const resolvedProvider = deps.settings.ai.createPr.provider;
  const effort = resolveEffort('createPr', deps.settings);
  const provider = createAiProvider({
    flow: 'createPr',
    ai: deps.settings.ai,
    harnessConfig: deps.settings.harness,
    eventBus: deps.eventBus,
  });
  const skillSource = buildComposedSkillSource(
    { app: deps, storage: deps.storage },
    {},
    resolvedProvider,
    'create-pr',
    deps.settings,
    {}
  );
  const skillsAdapter = createSkillsAdapter({ provider: resolvedProvider, logger: deps.logger });
  const flow = createCreatePrFlow(
    {
      sprintRepo: deps.sprintRepo,
      sprintExecutionRepo: deps.sprintExecutionRepo,
      taskRepo: deps.taskRepo,
      pullRequestCreator: deps.pullRequestCreator,
      gitRunner: deps.gitRunner,
      eventBus: deps.eventBus,
      clock: deps.clock,
      provider,
      templateLoader: deps.templateLoader,
      writeFile: deps.writeFile,
      logger: deps.logger,
      model: deps.settings.ai.createPr.model,
      ...(effort !== undefined ? { effort } : {}),
      skillSource,
      skillsAdapter,
    },
    { useAi, providerId: resolvedProvider }
  );
  const result = await flow.execute({
    input: {
      sprintId,
      cwd,
      sprintDir,
      base: DEFAULT_BASE,
      draft: DEFAULT_DRAFT,
    },
  });
  if (!result.ok) {
    return { kind: 'error', message: result.error.error.message };
  }
  return { kind: 'done', url: result.value.ctx.output!.url };
};

interface BodyProps {
  readonly prep: PrepState;
  readonly run: RunState;
  readonly useAi: boolean;
}

/** Flat if-returns instead of a nested ternary chain — same branch order and same JSX as before. */
const Body = ({ prep, run, useAi }: BodyProps): React.JSX.Element => {
  const content = renderBody(prep, run, useAi);
  return (
    <Box flexDirection="column" paddingX={spacing.indent} marginTop={spacing.section}>
      {content}
    </Box>
  );
};

const renderBody = (prep: PrepState, run: RunState, useAi: boolean): React.JSX.Element => {
  if (prep.kind === 'loading') return <Spinner label="Loading project + sprint execution…" />;
  if (prep.kind === 'error') {
    return (
      <Card title="Cannot open PR" tone="error">
        <Text color={inkColors.error}>
          {tones.error.glyph} {prep.message}
        </Text>
      </Card>
    );
  }
  if (run.kind === 'idle') {
    return (
      <Card title="Confirm" tone="rule">
        <Text>
          Branch <Text bold>{prep.branch}</Text> {glyphs.arrowRight} base <Text bold>{DEFAULT_BASE}</Text>{' '}
          {glyphs.bullet} draft: <Text bold>{DEFAULT_DRAFT ? 'yes' : 'no'}</Text>
        </Text>
        <Text>
          AI-authored: <Text bold>{useAi ? 'yes' : 'no'}</Text> {glyphs.bullet} press <Text bold>a</Text> to toggle
        </Text>
        <Text dimColor>
          press <Text bold>enter</Text> to open the PR · esc to back out · use the CLI for non-default base / draft /
          title / body
        </Text>
      </Card>
    );
  }
  if (run.kind === 'running') return <Spinner label="Opening pull request…" />;
  if (run.kind === 'done') {
    return (
      <Card title="Done" tone="success">
        <Text>
          <Text color={tones.success.color} bold>
            {tones.success.glyph}{' '}
          </Text>
          <Text bold>{run.url}</Text>
        </Text>
      </Card>
    );
  }
  return (
    <Card title="Failed" tone="error">
      <Text color={inkColors.error}>
        {tones.error.glyph} {run.message}
      </Text>
      <Text dimColor>press r to retry</Text>
    </Card>
  );
};
