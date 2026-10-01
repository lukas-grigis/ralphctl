/** Sprint header strip — the one place Work and Sprint detail say where a sprint stands. */

import React from 'react';
import { Box, Text } from 'ink';
import { SprintPipeline } from '@src/application/ui/tui/components/sprint-pipeline.tsx';
import { NextStepRow } from '@src/application/ui/tui/components/next-steps.tsx';
import { useTerminalSize } from '@src/application/ui/tui/runtime/use-terminal-size.ts';
import { breakpoints, glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { buildNextSteps, nextStepsInputFromSnapshot } from '@src/application/ui/shared/next-steps.ts';
import { plural } from '@src/application/ui/shared/plural.ts';
import { computeTaskHealthCounts, type AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import { fmtSpan } from '@src/application/ui/tui/theme/duration.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';

export interface SprintHeaderStripProps {
  readonly snapshot: AppStateSnapshot;
  readonly variant: 'work' | 'detail';
}

const stampMs = (iso: string | null | undefined): number | undefined => {
  if (iso === null || iso === undefined) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
};

interface Transition {
  readonly label: string;
  readonly at: number;
}

/** Lifecycle stamps the sprint carries, oldest first. Draft has none — sprints record no creation time. */
const transitionsOf = (sprint: Sprint): readonly Transition[] => {
  const raw: ReadonlyArray<readonly [string, string | null | undefined]> = [
    ['planned', sprint.plannedAt],
    ['active', sprint.activatedAt],
    ['review', sprint.reviewAt],
    ['done', sprint.doneAt],
  ];
  const out: Transition[] = [];
  for (const [label, iso] of raw) {
    const at = stampMs(iso);
    if (at !== undefined) out.push({ label, at });
  }
  return out;
};

const Sep = (): React.JSX.Element => <Text dimColor> {glyphs.bullet} </Text>;

const CountsRow = ({
  snapshot,
  showReady,
}: {
  readonly snapshot: AppStateSnapshot;
  readonly showReady: boolean;
}): React.JSX.Element | null => {
  const total = snapshot.tasks.length;
  if (total === 0) return null;
  const done = snapshot.tasks.filter((t) => t.status === 'done').length;
  const { blockedTaskCount } = computeTaskHealthCounts(snapshot.tasks);
  const ready = snapshot.triggerInputs.resumableTaskCount;
  return (
    <Text>
      <Text bold>{`${String(done)}/${String(total)}`}</Text>
      <Text dimColor> done</Text>
      {blockedTaskCount > 0 && (
        <>
          <Sep />
          <Text color={inkColors.error}>{String(blockedTaskCount)}</Text>
          <Text dimColor> blocked</Text>
        </>
      )}
      {showReady && ready > 0 && (
        <>
          <Sep />
          <Text color={inkColors.success}>{String(ready)}</Text>
          <Text dimColor> ready</Text>
        </>
      )}
    </Text>
  );
};

const FactsRow = ({
  sprint,
  taskCount,
  wide,
}: {
  readonly sprint: Sprint;
  readonly taskCount: number;
  readonly wide: boolean;
}): React.JSX.Element => {
  const now = Date.now();
  const transitions = transitionsOf(sprint);
  if (wide) {
    const timeline =
      transitions.length === 0
        ? 'draft'
        : transitions
            .map((t, i) => {
              const prev = transitions[i - 1];
              const gap = prev !== undefined ? ` (+${fmtSpan(t.at - prev.at)})` : '';
              return `${t.label} ${fmtSpan(now - t.at)} ago${gap}`;
            })
            .join(` ${glyphs.arrowRight} `);
    return (
      <Text dimColor wrap="truncate-end">
        {`${timeline} ${glyphs.bullet} slug ${sprint.slug}`}
      </Text>
    );
  }
  const current = transitions.find((t) => t.label === sprint.status);
  const facts = [
    plural(sprint.tickets.length, 'ticket'),
    plural(taskCount, 'task'),
    ...(current !== undefined ? [`${sprint.status} since ${fmtSpan(now - current.at)} ago`] : []),
  ];
  return (
    <Text dimColor wrap="truncate-end">
      {facts.join(` ${glyphs.bullet} `)}
    </Text>
  );
};

const NextRow = ({
  snapshot,
  wide,
}: {
  readonly snapshot: AppStateSnapshot;
  readonly wide: boolean;
}): React.JSX.Element | null => {
  const { steps } = buildNextSteps(nextStepsInputFromSnapshot(snapshot));
  const [first, ...rest] = steps;
  if (first === undefined) return null;
  return (
    <Text wrap="truncate-end">
      <Text dimColor>next: </Text>
      <NextStepRow step={first} />
      {wide
        ? rest.map((step, i) => (
            <React.Fragment key={`${step.label}-${String(i)}`}>
              <Text dimColor> {glyphs.bullet} then </Text>
              <NextStepRow step={step} />
            </React.Fragment>
          ))
        : rest.length > 0 && <Text dimColor>{` ${glyphs.bullet} +${String(rest.length)} more`}</Text>}
    </Text>
  );
};

export const SprintHeaderStrip = ({ snapshot, variant }: SprintHeaderStripProps): React.JSX.Element | null => {
  const { columns } = useTerminalSize();
  const sprint = snapshot.sprint;
  if (sprint === undefined) return null;
  const detail = variant === 'detail';
  return (
    <Box flexDirection="column" paddingX={spacing.indent}>
      <Box justifyContent="space-between">
        <SprintPipeline snapshot={snapshot} />
        <CountsRow snapshot={snapshot} showReady={columns >= breakpoints.md} />
      </Box>
      <FactsRow sprint={sprint} taskCount={snapshot.tasks.length} wide={detail && columns >= breakpoints.lg} />
      {detail && <NextRow snapshot={snapshot} wide={columns >= breakpoints.lg} />}
    </Box>
  );
};
