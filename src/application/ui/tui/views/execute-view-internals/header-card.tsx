/**
 * Header card for the execute view — flow id, elapsed, task counter, optional model line,
 * and active-task focus row (task index, current substep, gen-eval round). Extracted from
 * the orchestrator so the long JSX block isn't competing for visual attention with the
 * layout / column switching code.
 *
 * Model line semantics (implement runs only): when generator and evaluator differ the row
 * renders `<gen> → <eval> (eval)` so the operator can tell which model produces vs which
 * model judges. When they match (single-provider, single-model runs) the row collapses to
 * the bare model name — the arrow would be noise.
 *
 * Round counter: `TaskBucket.genEvalRound` is monotonic across the whole task (the `rounds/`
 * dir is shared by every attempt), while `genEvalMaxRounds` (`maxTurns`) caps a single attempt.
 * Rendering the raw ratio overshoots on a 2nd+ attempt (e.g. `round 4/3`), so the focus row
 * folds the round into per-attempt coordinates via `perAttemptRound` and shows the attempt
 * counter alongside it (`attempt A/X · round R/maxTurns`) whenever more than one attempt is in
 * play; single-attempt runs keep the bare `round R/maxTurns`.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { glyphs, inkColors } from '@src/application/ui/tui/theme/tokens.ts';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';
import { perAttemptRound, type TaskBucket } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';

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
  const modelLine =
    descriptor.generatorModel !== undefined && descriptor.evaluatorModel !== undefined
      ? descriptor.generatorModel === descriptor.evaluatorModel
        ? descriptor.generatorModel
        : `${descriptor.generatorModel} ${glyphs.arrowRight} ${descriptor.evaluatorModel} (eval)`
      : undefined;

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
        {modelLine !== undefined && (
          <Box>
            <Text dimColor>{glyphs.activityArrow} model </Text>
            <Text color={inkColors.highlight}>{modelLine}</Text>
          </Box>
        )}
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
                // Without a known per-attempt cap we can't fold the monotonic round into
                // per-attempt coordinates — fall back to the raw round (no `/M` to overshoot).
                if (maxTurns === undefined) {
                  return (
                    <>
                      <Text dimColor> {glyphs.bullet} round </Text>
                      <Text color={inkColors.info}>{String(currentTask.genEvalRound)}</Text>
                    </>
                  );
                }
                const { attemptN, roundInAttempt } = perAttemptRound(currentTask.genEvalRound, maxTurns);
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
                      {String(roundInAttempt)}/{String(maxTurns)}
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
