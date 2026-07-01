/**
 * Create-pull-request view — opens a PR / MR for the selected sprint's branch via the
 * configured platform CLI (`gh` / `glab`). Unlike the export-* views, this has an
 * external side effect (creates an upstream PR), so the view shows a one-line confirm
 * prompt before firing — pressing the view by mistake doesn't ship an unwanted PR.
 *
 * Defaults: base = `main`, draft = false, AI authoring = on. Press `a` on the idle
 * screen to toggle AI authoring off (the template-derived title + body wins instead).
 * Users who need other options run the `ralphctl create-pr` CLI command directly.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useViewHints } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { HelpOverlay } from '@src/application/ui/tui/components/help-overlay.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { createCreatePrFlow } from '@src/application/flows/create-pr/flow.ts';
import { createAiProvider } from '@src/application/bootstrap/provider-factory.ts';
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
  const ui = useUiState();
  const [prep, setPrep] = useState<PrepState>({ kind: 'loading' });
  const [run, setRun] = useState<RunState>({ kind: 'idle' });
  const [useAi, setUseAi] = useState<boolean>(true);
  useViewHints([
    { keys: '↵', label: 'open PR' },
    { keys: 'a', label: 'toggle AI' },
    { keys: 'r', label: 'retry', enabledWhen: run.kind === 'error' },
    { keys: 'esc', label: 'back' },
  ]);

  // Resolve cwd (project's first repo path) and branch (sprint-execution.branch) up front,
  // so the confirm card can show concrete values rather than spinning twice.
  useEffect(() => {
    // Guard the setPrep write behind a `cancelled` flag: if the selection changes (a new load
    // starts) or the view unmounts while `resolvePrepState`'s awaits are in flight, the stale
    // run must not write state — matches the cancelled-flag idiom used across the other async
    // views. `resolvePrepState` itself runs to natural completion regardless (see its own doc
    // comment); only the state write is gated here.
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

  useInput((input, key) => {
    if (ui.modalOpen) return;
    if (key.return && prep.kind === 'ready' && run.kind === 'idle') {
      void runCreate(prep.cwd);
      return;
    }
    if (input === 'a' && run.kind === 'idle') {
      setUseAi((prev) => !prev);
      return;
    }
    if (input === 'r' && run.kind === 'error') {
      // Back to the confirm card (re-enabling the `a` toggle) rather than re-firing directly —
      // this view creates an upstream PR, so every attempt goes through the explicit Enter.
      setRun({ kind: 'idle' });
    }
  });

  return (
    <ViewShell title="Create pull request" subtitle="open PR / MR for the sprint branch">
      {ui.helpOpen ? <HelpOverlay /> : <Body prep={prep} run={run} useAi={useAi} />}
    </ViewShell>
  );
};

/**
 * Resolve the confirm card's inputs: the project's first repo path (`cwd`) and the sprint
 * execution's branch. Pure I/O, no state writes — the caller's effect owns the cancelled-flag
 * gate around the resulting `setPrep`, so (like `useAsyncLoad`'s untracked loaders) this runs
 * to natural completion even if the caller ends up discarding the result.
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
 * Guard chain for the `runCreate` handler: sprint-selected check, then the PATH gate for the AI
 * step, then the sprint-dir resolve + parse. PATH-gates the AI step FIRST: the create-pr AI
 * session spawns the `createPr` row's provider CLI. Probe for it before any sprint I/O so a
 * missing binary surfaces the same actionable "binary not found" message every other AI flow
 * gives, instead of an opaque spawn failure mid-run. Only relevant when AI authoring is on — the
 * template path spawns no AI. Resolves the sprint dir via the tolerant id-prefix resolver (both
 * `<id>--<slug>/` and the legacy bare `<id>/`) — the view only holds the sprint id, not the
 * entity. Returns the failure `RunState` on error so the caller can `setRun` it directly.
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

/**
 * Build the createPr provider + flow and run it. Rebuilds the provider from the `createPr`
 * settings row rather than reusing `deps.provider` (the wire-time seed keyed on the `implement`
 * row) — in a mixed-provider config that would hand the createPr model string to the implement
 * provider's CLI, a provider/model mismatch. The model is already sourced from
 * `ai.createPr.model`, so the provider must match it.
 */
const executeCreatePrFlow = async (args: ExecuteCreatePrFlowArgs): Promise<RunState> => {
  const { deps, sprintId, sprintDir, cwd, useAi } = args;
  const provider = createAiProvider({
    flow: 'createPr',
    ai: deps.settings.ai,
    harnessConfig: deps.settings.harness,
    eventBus: deps.eventBus,
  });
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
    },
    { useAi }
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

/**
 * Flat if-returns instead of a nested ternary chain — same branch order and same JSX as before,
 * just laid out as one branch per line (mirrors `SprintDetailContent` in sprint-detail-view.tsx,
 * the established fix for this exact cognitive-complexity shape in this codebase).
 */
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
      <Card title="Cannot open PR" tone="rule">
        <Text color={inkColors.error}>
          {glyphs.bullet} {prep.message}
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
      <Card title="Done" tone="rule">
        <Text>
          <Text color={inkColors.primary} bold>
            {glyphs.check}{' '}
          </Text>
          <Text bold>{run.url}</Text>
        </Text>
      </Card>
    );
  }
  return (
    <Card title="Failed" tone="rule">
      <Text color={inkColors.error}>
        {glyphs.bullet} {run.message}
      </Text>
      <Text dimColor>press r to retry</Text>
    </Card>
  );
};
