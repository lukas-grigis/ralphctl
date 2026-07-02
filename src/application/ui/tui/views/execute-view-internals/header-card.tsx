/**
 * Header card for the execute view — flow id, elapsed, task counter, optional model lines,
 * and active-task focus row (task index, current substep, gen-eval round). Extracted from
 * the orchestrator so the long JSX block isn't competing for visual attention with the
 * layout / column switching code.
 *
 * Model line semantics (implement runs only): when `generatorModel` / `evaluatorModel` are
 * set on the descriptor the card renders TWO explicit lines — `generator <model> · <effort>`
 * and `evaluator <model> · <effort>` — even when the two models are the same. This gives the
 * operator unambiguous visibility into both roles. The effort suffix is omitted when undefined.
 * Non-implement flows (no gen/eval split) keep a single `model <name>` line if either field
 * happens to be set by their launcher; in practice those flows leave both undefined.
 *
 * Round counter: `TaskBucket.genEvalRound` is monotonic across the whole task (the `rounds/`
 * dir is shared by every attempt), while `genEvalMaxRounds` (`maxTurns`) caps a single attempt.
 * Rendering the raw ratio overshoots on a 2nd+ attempt (e.g. `round 4/3`), so the focus row
 * folds the round into per-attempt coordinates via `resolveAttemptCoords` (which prefers the live
 * tracker-sourced attempt number and falls back to the `perAttemptRound` division heuristic) and
 * shows the attempt counter alongside it (`attempt A/X · round R/maxTurns`) whenever more than one
 * attempt is in play; single-attempt runs keep the bare `round R/maxTurns`.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { glyphs, inkColors } from '@src/application/ui/tui/theme/tokens.ts';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';
import { resolveAttemptCoords, type TaskBucket } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import { contextWindowLabel } from '@src/domain/value/settings-models/context-window.ts';

interface HeaderCardProps {
  readonly descriptor: SessionDescriptor;
  readonly isRunning: boolean;
  readonly elapsed: string;
  readonly tasksDone: number;
  readonly tasksTotal: number;
  readonly currentTask: TaskBucket | undefined;
  readonly currentTaskIdx: number;
  readonly currentTaskName: string | undefined;
  readonly currentSubStep: string | undefined;
}

/**
 * Renders the model + effort lines inside the HeaderCard.
 *
 * Implement runs (both `generatorModel` and `evaluatorModel` set): two explicit lines so the
 * operator can clearly see each role, even when generator === evaluator. When the role's provider
 * id is known it renders dim before the model (secondary context) — model stays highlighted.
 *
 *   ↳ generator  github-copilot · claude-opus-4-8 · high
 *   ↳ evaluator  openai-codex · gpt-5.5 · medium
 *
 * Non-implement flows (at most one model set): single `model <name>` line, optionally prefixed
 * with the provider when one is available. When neither model is set: nothing rendered.
 */
const RoleLine = ({
  role,
  provider,
  model,
  effort,
}: {
  readonly role: string;
  readonly provider: string | undefined;
  readonly model: string;
  readonly effort: string | undefined;
}): React.JSX.Element => {
  const ctxWindow = contextWindowLabel(model);
  return (
    <Box>
      <Text dimColor>
        {glyphs.activityArrow} {role}{' '}
      </Text>
      {provider !== undefined && (
        <>
          <Text dimColor>{provider}</Text>
          <Text dimColor> {glyphs.bullet} </Text>
        </>
      )}
      <Text color={inkColors.highlight}>{model}</Text>
      {ctxWindow !== undefined && (
        <>
          <Text dimColor> {glyphs.bullet} </Text>
          <Text dimColor>{ctxWindow}</Text>
        </>
      )}
      {effort !== undefined && (
        <>
          <Text dimColor> {glyphs.bullet} </Text>
          <Text dimColor>{effort}</Text>
        </>
      )}
    </Box>
  );
};

const ModelLines = ({
  generatorModel,
  evaluatorModel,
  generatorProvider,
  evaluatorProvider,
  generatorEffort,
  evaluatorEffort,
}: {
  readonly generatorModel: string | undefined;
  readonly evaluatorModel: string | undefined;
  readonly generatorProvider: string | undefined;
  readonly evaluatorProvider: string | undefined;
  readonly generatorEffort: string | undefined;
  readonly evaluatorEffort: string | undefined;
}): React.JSX.Element | null => {
  // Implement runs: both roles explicitly set — render two labelled lines.
  if (generatorModel !== undefined && evaluatorModel !== undefined) {
    return (
      <Box flexDirection="column">
        <RoleLine role="generator" provider={generatorProvider} model={generatorModel} effort={generatorEffort} />
        <RoleLine role="evaluator" provider={evaluatorProvider} model={evaluatorModel} effort={evaluatorEffort} />
      </Box>
    );
  }

  // Non-implement flows: single model line (whichever is set), with its provider + window when available.
  const model = generatorModel ?? evaluatorModel;
  const provider = generatorProvider ?? evaluatorProvider;
  if (model !== undefined) {
    const ctxWindow = contextWindowLabel(model);
    return (
      <Box>
        <Text dimColor>{glyphs.activityArrow} model </Text>
        {provider !== undefined && (
          <>
            <Text dimColor>{provider}</Text>
            <Text dimColor> {glyphs.bullet} </Text>
          </>
        )}
        <Text color={inkColors.highlight}>{model}</Text>
        {ctxWindow !== undefined && (
          <>
            <Text dimColor> {glyphs.bullet} </Text>
            <Text dimColor>{ctxWindow}</Text>
          </>
        )}
      </Box>
    );
  }

  return null;
};

export const HeaderCard = ({
  descriptor,
  isRunning,
  elapsed,
  tasksDone,
  tasksTotal,
  currentTask,
  currentTaskIdx,
  currentTaskName,
  currentSubStep,
}: HeaderCardProps): React.JSX.Element => {
  return (
    <Card title={descriptor.title} tone={isRunning ? 'info' : descriptor.status === 'completed' ? 'success' : 'rule'}>
      <Box flexDirection="column">
        <Box>
          <Text dimColor>flow </Text>
          <Text>{descriptor.flowId}</Text>
          <Text dimColor> {glyphs.bullet} elapsed </Text>
          <Text>{elapsed}</Text>
          {tasksTotal > 0 && (
            <>
              <Text dimColor> {glyphs.bullet} tasks </Text>
              {tasksDone === tasksTotal && tasksTotal > 0 ? (
                <Text color={inkColors.success}>
                  {String(tasksDone)}/{String(tasksTotal)}
                </Text>
              ) : (
                <Text>
                  {String(tasksDone)}/{String(tasksTotal)}
                </Text>
              )}
            </>
          )}
          {isRunning && (
            <Box marginLeft={2}>
              <Spinner active={isRunning} color={inkColors.info} label="live" />
            </Box>
          )}
        </Box>
        <ModelLines
          generatorModel={descriptor.generatorModel}
          evaluatorModel={descriptor.evaluatorModel}
          generatorProvider={descriptor.generatorProvider}
          evaluatorProvider={descriptor.evaluatorProvider}
          generatorEffort={descriptor.generatorEffort}
          evaluatorEffort={descriptor.evaluatorEffort}
        />
        {currentTask !== undefined && currentTaskName !== undefined && (
          <Box>
            <Text dimColor>{glyphs.activityArrow} task </Text>
            <Text color={inkColors.info}>
              {String(currentTaskIdx + 1)}/{String(tasksTotal)}
            </Text>
            <Text dimColor> {glyphs.bullet} </Text>
            <Text bold>{currentTaskName}</Text>
            {currentSubStep !== undefined && (
              <>
                <Text dimColor> {glyphs.bullet} step </Text>
                <Text color={inkColors.highlight}>{currentSubStep}</Text>
              </>
            )}
            {currentTask.genEvalRound > 0 &&
              (() => {
                const maxTurns = currentTask.genEvalMaxRounds;
                const maxAttempts = currentTask.genEvalMaxAttempts;
                const coords = resolveAttemptCoords(currentTask);
                // No attempt-relative coordinates — no live tracker data AND no `maxTurns` cap to
                // fold the monotonic round against — so fall back to the raw round (no `/M`).
                if (coords === undefined) {
                  return (
                    <>
                      <Text dimColor> {glyphs.bullet} round </Text>
                      <Text color={inkColors.info}>{String(currentTask.genEvalRound)}</Text>
                    </>
                  );
                }
                const { attemptN, roundInAttempt } = coords;
                const showAttempt = attemptN > 1 || (maxAttempts !== undefined && maxAttempts > 1);
                return (
                  <>
                    {showAttempt && (
                      <>
                        <Text dimColor> {glyphs.bullet} attempt </Text>
                        <Text color={inkColors.info}>
                          {String(attemptN)}
                          {maxAttempts !== undefined ? `/${String(maxAttempts)}` : ''}
                        </Text>
                      </>
                    )}
                    <Text dimColor> {glyphs.bullet} round </Text>
                    <Text color={inkColors.info}>
                      {String(roundInAttempt)}
                      {maxTurns !== undefined ? `/${String(maxTurns)}` : ''}
                    </Text>
                  </>
                );
              })()}
          </Box>
        )}
      </Box>
    </Card>
  );
};
