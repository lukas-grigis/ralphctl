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
import { join } from 'node:path';
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
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';

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
    const load = async (): Promise<void> => {
      if (selection.projectId === undefined || selection.sprintId === undefined) {
        setPrep({ kind: 'error', message: 'No project or sprint selected.' });
        return;
      }
      const project = await deps.projectRepo.findById(selection.projectId);
      if (!project.ok) {
        setPrep({ kind: 'error', message: project.error.message });
        return;
      }
      const cwd = project.value.repositories[0]?.path;
      if (cwd === undefined) {
        setPrep({ kind: 'error', message: 'Project has no repositories — add one first.' });
        return;
      }
      const execution = await deps.sprintExecutionRepo.findById(selection.sprintId);
      if (!execution.ok) {
        setPrep({ kind: 'error', message: execution.error.message });
        return;
      }
      if (execution.value.branch === null) {
        setPrep({ kind: 'error', message: 'Sprint has no branch — implement at least one task first.' });
        return;
      }
      setPrep({ kind: 'ready', cwd, branch: execution.value.branch });
    };
    void load();
  }, [deps, selection.projectId, selection.sprintId]);

  const runCreate = useCallback(
    async (cwd: AbsolutePath): Promise<void> => {
      if (selection.sprintId === undefined) {
        setRun({ kind: 'error', message: 'No sprint selected.' });
        return;
      }
      const sprintDir = AbsolutePath.parse(join(String(deps.storage.dataRoot), 'sprints', String(selection.sprintId)));
      if (!sprintDir.ok) {
        setRun({ kind: 'error', message: `sprint dir: ${sprintDir.error.message}` });
        return;
      }
      // PATH-gate the AI step: the create-pr AI session spawns the `createPr` row's provider
      // CLI. Probe for it before firing so a missing binary surfaces the same actionable
      // "binary not found" message every other AI flow gives, instead of an opaque spawn
      // failure mid-run. Only relevant when AI authoring is on — the template path spawns no AI.
      if (useAi) {
        const gate = await checkCli('create-pr', deps.settings);
        if (gate !== undefined && !gate.ok) {
          setRun({ kind: 'error', message: gate.reason });
          return;
        }
      }
      setRun({ kind: 'running' });
      // Rebuild the provider from the `createPr` settings row. `deps.provider` is the wire-time
      // seed keyed on the `implement` row; in a mixed-provider config that hands the createPr
      // model string to the implement provider's CLI — a provider/model mismatch. The model is
      // already sourced from `ai.createPr.model`, so the provider must match it.
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
          sprintId: selection.sprintId,
          cwd,
          sprintDir: sprintDir.value,
          base: DEFAULT_BASE,
          draft: DEFAULT_DRAFT,
        },
      });
      if (!result.ok) {
        setRun({ kind: 'error', message: result.error.error.message });
        return;
      }
      setRun({ kind: 'done', url: result.value.ctx.output!.url });
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
      {ui.helpOpen ? (
        <HelpOverlay />
      ) : (
        <Box flexDirection="column" paddingX={spacing.indent} marginTop={spacing.section}>
          {prep.kind === 'loading' ? (
            <Spinner label="Loading project + sprint execution…" />
          ) : prep.kind === 'error' ? (
            <Card title="Cannot open PR" tone="rule">
              <Text color={inkColors.error}>
                {glyphs.bullet} {prep.message}
              </Text>
            </Card>
          ) : run.kind === 'idle' ? (
            <Card title="Confirm" tone="rule">
              <Text>
                Branch <Text bold>{prep.branch}</Text> {glyphs.arrowRight} base <Text bold>{DEFAULT_BASE}</Text>{' '}
                {glyphs.bullet} draft: <Text bold>{DEFAULT_DRAFT ? 'yes' : 'no'}</Text>
              </Text>
              <Text>
                AI-authored: <Text bold>{useAi ? 'yes' : 'no'}</Text> {glyphs.bullet} press <Text bold>a</Text> to
                toggle
              </Text>
              <Text dimColor>
                press <Text bold>enter</Text> to open the PR · esc to back out · use the CLI for non-default base /
                draft / title / body
              </Text>
            </Card>
          ) : run.kind === 'running' ? (
            <Spinner label="Opening pull request…" />
          ) : run.kind === 'done' ? (
            <Card title="Done" tone="rule">
              <Text>
                <Text color={inkColors.primary} bold>
                  {glyphs.check}{' '}
                </Text>
                <Text bold>{run.url}</Text>
              </Text>
            </Card>
          ) : (
            <Card title="Failed" tone="rule">
              <Text color={inkColors.error}>
                {glyphs.bullet} {run.message}
              </Text>
              <Text dimColor>press r to retry</Text>
            </Card>
          )}
        </Box>
      )}
    </ViewShell>
  );
};
