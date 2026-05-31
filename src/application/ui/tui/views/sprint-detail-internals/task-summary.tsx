/**
 * Tasks pane for the sprint-detail view — task count / status breakdown rendered as a list of
 * bordered cards, one per task. Each card collapses to a metadata row (ticket / deps / repo /
 * attempts / last-attempt elapsed) and expands inline to show steps, verification criteria,
 * dependencies, and attempt history when the orchestrator marks it via `openIds`.
 *
 * Holds the task list + per-task render helpers (`buildTaskMetadataParts`, the inline-vs-wrap
 * metadata splitter, repo-name lookup) because they're only used here. Per-attempt rendering
 * lives in `attempt-card.tsx` to keep this file under the 350-LOC budget.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { ListCard } from '@src/application/ui/tui/components/list-card.tsx';
import { EmptyState } from '@src/application/ui/tui/components/empty-state.tsx';
import { StatusChip, taskStatusKind } from '@src/application/ui/tui/components/status-chip.tsx';
import { FieldList } from '@src/application/ui/tui/components/field-list.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useBreakpoint } from '@src/application/ui/tui/runtime/use-breakpoint.ts';
import { fmtDuration } from '@src/application/ui/tui/theme/duration.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { Attempt } from '@src/domain/entity/attempt.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import { Description, Section } from '@src/application/ui/tui/views/sprint-detail-internals/shared-prose.tsx';
import type { FocusItem } from '@src/application/ui/tui/views/sprint-detail-internals/focus-list.ts';
import { AttemptCard, attemptElapsedMs } from '@src/application/ui/tui/views/sprint-detail-internals/attempt-card.tsx';

interface TasksSectionProps {
  readonly sprint: Sprint;
  readonly tasks: readonly Task[];
  readonly focusList: readonly FocusItem[];
  readonly cursorIdx: number;
  readonly project: Project | undefined;
  readonly openIds: ReadonlySet<string>;
}

export const TasksSection = ({
  sprint,
  tasks,
  focusList,
  cursorIdx,
  project,
  openIds,
}: TasksSectionProps): React.JSX.Element => (
  <Box marginTop={spacing.section} flexDirection="column">
    <Text bold>{glyphs.badge} Tasks</Text>
    {tasks.length === 0 ? (
      <Box marginTop={1}>
        <EmptyState title="No tasks yet" hint="Run plan from Flows (n) once tickets are approved." />
      </Box>
    ) : (
      <Box flexDirection="column" marginTop={1}>
        {tasks.map((task, idx) => {
          const focusItem = focusList[cursorIdx];
          const focused = focusItem?.kind === 'task' && focusItem.task.id === task.id;
          const expanded = openIds.has(String(task.id));
          const ticket = sprint.tickets.find((t) => t.id === task.ticketId);
          const repoName = repositoryName(project, task.repositoryId);
          return (
            <TaskCard
              key={task.id}
              task={task}
              sprint={sprint}
              tasks={tasks}
              project={project}
              ticketTitle={ticket?.title}
              repoName={repoName}
              focused={focused}
              expanded={expanded}
              index={idx + 1}
            />
          );
        })}
      </Box>
    )}
    <Box paddingX={spacing.indent} marginTop={spacing.section}>
      <Text dimColor>{glyphs.bullet} ↵/o expand/collapse</Text>
    </Box>
  </Box>
);

const TaskCard = ({
  task,
  sprint,
  tasks,
  project,
  ticketTitle,
  repoName,
  focused,
  expanded,
  index,
}: {
  readonly task: Task;
  readonly sprint: Sprint;
  readonly tasks: readonly Task[];
  readonly project: Project | undefined;
  readonly ticketTitle: string | undefined;
  readonly repoName: string | undefined;
  readonly focused: boolean;
  readonly expanded: boolean;
  readonly index: number;
}): React.JSX.Element => {
  const lastAttempt: Attempt | undefined = task.attempts[task.attempts.length - 1];
  const lastAttemptElapsed = lastAttempt !== undefined ? attemptElapsedMs(lastAttempt) : undefined;
  const { atLeast } = useBreakpoint();
  // At ≥md (≥100 cols) the metadata row stays on a single line and ellides on overflow so the
  // task card height stays a predictable two lines. Below md, the row is allowed to wrap so
  // narrow terminals don't lose information at the tail.
  const singleLineMetadata = atLeast('md');
  const metadataParts: readonly React.ReactNode[] = buildTaskMetadataParts({
    ticketTitle,
    dependsOnCount: task.dependsOn.length,
    repoName,
    attempts: task.attempts.length,
    maxAttempts: task.maxAttempts,
    lastAttemptElapsed,
  });
  return (
    <ListCard
      focused={focused}
      rightSlot={<StatusChip label={task.status} kind={taskStatusKind(task.status)} />}
      indexLabel={`#${String(index)}`}
      title={task.name}
    >
      {singleLineMetadata ? (
        <Box>
          <Text wrap="truncate-end" dimColor>
            {joinMetadataInline(metadataParts)}
          </Text>
        </Box>
      ) : (
        <Box flexWrap="wrap">
          {metadataParts.map((node, i) => (
            <Text key={`meta-${String(i)}`} dimColor>
              {i > 0 ? ' ' : ''}
              {node}
            </Text>
          ))}
        </Box>
      )}
      {!expanded && task.description !== undefined && <Description text={task.description} maxLines={2} />}
      {!expanded && task.status === 'blocked' && (
        <Box paddingLeft={2}>
          <Text color={inkColors.error}>
            {glyphs.cross} blocked: {task.blockedReason}
          </Text>
        </Box>
      )}
      {expanded && <TaskDetailBody task={task} sprint={sprint} tasks={tasks} project={project} />}
    </ListCard>
  );
};

interface TaskMetadataInput {
  readonly ticketTitle: string | undefined;
  readonly dependsOnCount: number;
  readonly repoName: string | undefined;
  readonly attempts: number;
  readonly maxAttempts: number | undefined;
  readonly lastAttemptElapsed: number | undefined;
}

/**
 * Build the per-field React nodes for the task metadata row. Each entry already carries its
 * leading bullet glyph (`·`); the caller decides whether to join them on one line (with an
 * intervening space) or render them as wrapped flex items.
 */
const buildTaskMetadataParts = (input: TaskMetadataInput): readonly React.ReactNode[] => {
  const parts: React.ReactNode[] = [];
  if (input.ticketTitle !== undefined) {
    parts.push(
      <React.Fragment key="ticket">
        {glyphs.bullet} ticket: <Text bold>{input.ticketTitle}</Text>
      </React.Fragment>
    );
  }
  if (input.dependsOnCount > 0) {
    parts.push(
      <React.Fragment key="deps">
        {glyphs.bullet} {String(input.dependsOnCount)} dep{input.dependsOnCount === 1 ? '' : 's'}
      </React.Fragment>
    );
  }
  if (input.repoName !== undefined) {
    parts.push(
      <React.Fragment key="repo">
        {glyphs.bullet} repo: <Text>{input.repoName}</Text>
      </React.Fragment>
    );
  }
  parts.push(
    <React.Fragment key="attempts">
      {glyphs.bullet} attempts: {String(input.attempts)}
      {input.maxAttempts !== undefined ? `/${String(input.maxAttempts)}` : ''}
    </React.Fragment>
  );
  if (input.lastAttemptElapsed !== undefined) {
    parts.push(
      <React.Fragment key="last">
        {glyphs.bullet} last: {fmtDuration(input.lastAttemptElapsed)}
      </React.Fragment>
    );
  }
  return parts;
};

const joinMetadataInline = (parts: readonly React.ReactNode[]): React.ReactNode =>
  parts.map((node, i) => (
    <React.Fragment key={`inline-${String(i)}`}>
      {i > 0 ? ' ' : ''}
      {node}
    </React.Fragment>
  ));

const repositoryName = (project: Project | undefined, id: RepositoryId): string | undefined => {
  if (project === undefined) return undefined;
  const repo = project.repositories.find((r) => r.id === id);
  return repo?.name;
};

const TaskDetailBody = ({
  task,
  sprint,
  tasks,
  project,
}: {
  readonly task: Task;
  readonly sprint: Sprint;
  readonly tasks: readonly Task[];
  readonly project: Project | undefined;
}): React.JSX.Element => {
  const ticket = sprint.tickets.find((t) => t.id === task.ticketId);
  const dependsOnTasks = task.dependsOn
    .map((id): Task | undefined => tasks.find((t) => t.id === id))
    .filter((t): t is Task => t !== undefined);
  const repoName = repositoryName(project, task.repositoryId);
  return (
    <Box flexDirection="column">
      <FieldList
        fields={[
          { label: 'Order', value: String(task.order) },
          {
            label: 'Repository',
            value: repoName !== undefined ? `${repoName}  (${String(task.repositoryId)})` : String(task.repositoryId),
          },
          {
            label: 'Ticket',
            value: ticket !== undefined ? `${ticket.title}  [${ticket.status}]` : String(task.ticketId),
          },
          ...(task.status === 'done' ? [{ label: 'Final attempt', value: `#${String(task.finalAttemptN)}` }] : []),
          ...(task.extraDimensions !== undefined && task.extraDimensions.length > 0
            ? [{ label: 'Extra dims', value: task.extraDimensions.join(', ') }]
            : []),
        ]}
      />
      {task.status === 'blocked' && (
        <Box marginTop={1}>
          <Text color={inkColors.error}>
            {glyphs.cross} blocked: {task.blockedReason}
          </Text>
        </Box>
      )}
      {task.description !== undefined && (
        <Section heading="Description">
          <Description text={task.description} maxLines={Number.POSITIVE_INFINITY} />
        </Section>
      )}
      {task.steps.length > 0 && (
        <Section heading="Steps">
          <Box flexDirection="column" paddingLeft={2}>
            {task.steps.map((s, i) => (
              <Text key={`step-${String(i)}`} dimColor>
                {String(i + 1)}. {s}
              </Text>
            ))}
          </Box>
        </Section>
      )}
      {task.verificationCriteria.length > 0 && (
        <Section heading="Verification">
          <Box flexDirection="column" paddingLeft={2}>
            {task.verificationCriteria.map((c, i) => (
              <Text key={`vc-${String(i)}`} dimColor>
                {glyphs.bullet} [{c.id}] {c.check}
                {c.check === 'auto' && c.command !== undefined ? ` \`${c.command}\`` : ''} — {c.assertion}
              </Text>
            ))}
          </Box>
        </Section>
      )}
      {dependsOnTasks.length > 0 && (
        <Section heading="Depends on">
          <Box flexDirection="column" paddingLeft={2}>
            {dependsOnTasks.map((d) => (
              <Box key={d.id}>
                <StatusChip label={d.status} kind={taskStatusKind(d.status)} />
                <Text bold> {d.name}</Text>
              </Box>
            ))}
          </Box>
        </Section>
      )}
      {task.attempts.length > 0 && (
        <Section heading="Attempt history">
          <Box flexDirection="column" paddingLeft={2}>
            {task.attempts.map((attempt) => (
              <AttemptCard key={`attempt-${String(attempt.n)}`} attempt={attempt} />
            ))}
          </Box>
        </Section>
      )}
    </Box>
  );
};
