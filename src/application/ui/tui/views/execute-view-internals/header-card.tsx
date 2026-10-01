/**
 * Header card for the execute view — flow id, elapsed, task counter, optional model lines, and active-task focus row
 * (task index, current substep, gen-eval round).
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';
import { resolveAttemptCoords, type TaskBucket } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import { contextWindowLabel } from '@src/domain/value/settings-models/context-window.ts';
import { ElapsedLabel } from '@src/application/ui/tui/views/execute-view-internals/elapsed-label.tsx';

interface HeaderCardProps {
  readonly descriptor: SessionDescriptor;
  readonly isRunning: boolean;
  readonly tasksDone: number;
  readonly tasksTotal: number;
  readonly currentTask: TaskBucket | undefined;
  readonly currentTaskIdx: number;
  readonly currentTaskName: string | undefined;
  readonly currentSubStep: string | undefined;
  /** Epoch ms the run started waiting on a prompt; set while an operator answer blocks it. */
  readonly waitingSince?: number | undefined;
}

/** Renders the model + effort lines inside the HeaderCard. */
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

/** Flow id, elapsed, task counter and the live spinner — the card's always-present first row. */
const SummaryRow = ({
  descriptor,
  isRunning,
  tasksDone,
  tasksTotal,
  waitingSince,
}: {
  readonly descriptor: SessionDescriptor;
  readonly isRunning: boolean;
  readonly tasksDone: number;
  readonly tasksTotal: number;
  readonly waitingSince: number | undefined;
}): React.JSX.Element => (
  <Box>
    <Text dimColor>flow </Text>
    <Text>{descriptor.flowId}</Text>
    <Text dimColor>
      {' '}
      {glyphs.bullet} {waitingSince !== undefined ? 'waiting' : 'elapsed'}{' '}
    </Text>
    <ElapsedLabel
      startedAt={waitingSince ?? descriptor.startedAt}
      finishedAt={waitingSince !== undefined ? undefined : descriptor.finishedAt}
      isRunning={isRunning}
    />
    {tasksTotal > 0 && (
      <>
        <Text dimColor> {glyphs.bullet} tasks </Text>
        {tasksDone === tasksTotal ? (
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
    {isRunning && waitingSince !== undefined && (
      <Box marginLeft={spacing.indent}>
        <Text color={inkColors.warning} bold>
          {glyphs.warningGlyph} [WAITING]
        </Text>
        <Text dimColor> your answer</Text>
      </Box>
    )}
    {isRunning && waitingSince === undefined && (
      <Box marginLeft={spacing.indent}>
        <Spinner active={isRunning} color={inkColors.info} label="live" />
      </Box>
    )}
  </Box>
);

/**
 * `attempt A/X · round R/maxTurns` chip for the focus row — see the module docstring for why the monotonic round is
 * folded into per-attempt coordinates first.
 */
const RoundCounter = ({ task }: { readonly task: TaskBucket }): React.JSX.Element | null => {
  if (task.genEvalRound <= 0) return null;
  const maxTurns = task.genEvalMaxRounds;
  const maxAttempts = task.genEvalMaxAttempts;
  const coords = resolveAttemptCoords(task);
  // No attempt-relative coordinates — no live tracker data AND no `maxTurns` cap to fold the
  // monotonic round against — so fall back to the raw round (no `/M`).
  if (coords === undefined) {
    return (
      <>
        <Text dimColor> {glyphs.bullet} round </Text>
        <Text color={inkColors.info}>{String(task.genEvalRound)}</Text>
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
};

/** Active-task focus row — task index, name, current sub-step, round counter. Self-gates. */
const ActiveTaskRow = ({
  currentTask,
  currentTaskIdx,
  currentTaskName,
  currentSubStep,
  tasksTotal,
}: {
  readonly currentTask: TaskBucket | undefined;
  readonly currentTaskIdx: number;
  readonly currentTaskName: string | undefined;
  readonly currentSubStep: string | undefined;
  readonly tasksTotal: number;
}): React.JSX.Element | null => {
  if (currentTask === undefined || currentTaskName === undefined) return null;
  // One truncating <Text>: separate flex items shrink and drop their trailing spaces ("task1/1"), and wrap a tick early.
  return (
    <Text wrap="truncate-end">
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
      <RoundCounter task={currentTask} />
    </Text>
  );
};

const HeaderCardImpl = ({
  descriptor,
  isRunning,
  tasksDone,
  tasksTotal,
  currentTask,
  currentTaskIdx,
  currentTaskName,
  currentSubStep,
  waitingSince,
}: HeaderCardProps): React.JSX.Element => (
  <Card
    title={descriptor.title}
    tone={
      isRunning
        ? waitingSince !== undefined
          ? 'warning'
          : 'info'
        : descriptor.status === 'completed'
          ? 'success'
          : 'rule'
    }
  >
    <Box flexDirection="column">
      <SummaryRow
        descriptor={descriptor}
        isRunning={isRunning}
        tasksDone={tasksDone}
        tasksTotal={tasksTotal}
        waitingSince={waitingSince}
      />
      <ModelLines
        generatorModel={descriptor.generatorModel}
        evaluatorModel={descriptor.evaluatorModel}
        generatorProvider={descriptor.generatorProvider}
        evaluatorProvider={descriptor.evaluatorProvider}
        generatorEffort={descriptor.generatorEffort}
        evaluatorEffort={descriptor.evaluatorEffort}
      />
      <ActiveTaskRow
        currentTask={currentTask}
        currentTaskIdx={currentTaskIdx}
        currentTaskName={currentTaskName}
        currentSubStep={currentSubStep}
        tasksTotal={tasksTotal}
      />
    </Box>
  </Card>
);

// Memoized: `elapsed` moved into the self-ticking `<ElapsedLabel>` leaf above, so this card's own props are now
// stable across the 1 Hz clock tick.
export const HeaderCard = React.memo(HeaderCardImpl);
