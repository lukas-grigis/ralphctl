import { getTasks } from '@src/integration/persistence/task.ts';
import type { Task, Tasks } from '@src/domain/models.ts';
import { TaskNotFoundError } from '@src/domain/errors.ts';
import { colors } from '@src/integration/ui/theme/theme.ts';
import { formatTaskStatus, icons, log, printHeader, showError, showNextStep } from '@src/integration/ui/theme/ui.ts';
import { ensureError, wrapAsync } from '@src/integration/utils/result-helpers.ts';
import { selectTask } from '@src/integration/cli/commands/shared/selectors.ts';

interface WhyNode {
  task: Task;
  depth: number;
  missing: boolean;
}

/**
 * Walk the blockedBy graph from `root`, producing a depth-first trail of blocker
 * nodes. Cycles are protected by a visited set (architecturally tasks should not
 * cycle — DependencyCycleError is raised at import — but defensive here).
 */
function collectBlockers(root: Task, byId: Map<string, Task>): WhyNode[] {
  const out: WhyNode[] = [];
  const visited = new Set<string>([root.id]);

  function walk(task: Task, depth: number): void {
    for (const blockerId of task.blockedBy) {
      const blocker = byId.get(blockerId);
      if (!blocker) {
        out.push({
          task: { id: blockerId, name: `(missing ${blockerId})`, status: 'todo' } as Task,
          depth,
          missing: true,
        });
        continue;
      }
      if (visited.has(blocker.id)) continue;
      visited.add(blocker.id);
      out.push({ task: blocker, depth, missing: false });
      if (blocker.status !== 'done') walk(blocker, depth + 1);
    }
  }

  walk(root, 0);
  return out;
}

function renderBlockerLine(node: WhyNode): string {
  const indent = '    ' + '  '.repeat(node.depth);
  const connector = colors.muted(node.depth === 0 ? '├─' : '↳');
  const idPart = colors.muted(node.task.id);
  if (node.missing) {
    return `${indent}${connector} ${colors.error(icons.error)} ${idPart}  ${colors.error('(referenced but missing)')}`;
  }
  const status = formatTaskStatus(node.task.status);
  const marker = node.task.status === 'done' ? colors.success(icons.success) : colors.warning(icons.warning);
  return `${indent}${connector} ${marker} ${idPart}  ${node.task.name}  ${status}`;
}

export async function taskWhyCommand(taskId?: string): Promise<void> {
  let id = taskId;
  if (!id) {
    const selected = await selectTask('Which task is blocked?');
    if (!selected) return;
    id = selected;
  }

  const r = await wrapAsync<Tasks, Error>(() => getTasks(), ensureError);
  if (!r.ok) {
    showError(r.error.message);
    return;
  }

  const tasks = r.value;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const root = byId.get(id);
  if (!root) {
    showError(new TaskNotFoundError(id).message);
    return;
  }

  printHeader('Why blocked?');
  log.newline();
  console.log(`  ${icons.task} ${colors.highlight(root.name)}  ${formatTaskStatus(root.status)}`);
  console.log(`  ${colors.muted('id:')} ${colors.muted(root.id)}`);
  log.newline();

  if (root.status === 'done') {
    console.log(`  ${colors.success(icons.success)} ${colors.success('Task is done — nothing blocking it.')}`);
    log.newline();
    return;
  }

  if (root.blockedBy.length === 0) {
    console.log(`  ${colors.success(icons.success)} ${colors.success('No blockers — ready to execute.')}`);
    log.newline();
    showNextStep(`ralphctl task status ${root.id} in_progress`, 'Start working on this task');
    log.newline();
    return;
  }

  const nodes = collectBlockers(root, byId);
  const unmet = nodes.filter((n) => !n.missing && n.task.status !== 'done');
  const leafUnmet = unmet.filter((n) => n.task.blockedBy.every((bid) => byId.get(bid)?.status === 'done'));

  console.log(`  ${colors.muted('Dependency chain:')}`);
  for (const node of nodes) console.log(renderBlockerLine(node));
  log.newline();

  if (unmet.length === 0) {
    console.log(`  ${colors.success(icons.success)} ${colors.success('All blockers are done — ready to execute.')}`);
    log.newline();
    showNextStep(`ralphctl task status ${root.id} in_progress`, 'Start working on this task');
    log.newline();
    return;
  }

  const actionable = leafUnmet.length > 0 ? leafUnmet : unmet;
  console.log(
    `  ${colors.warning(icons.warning)} ${colors.warning(`Unblock by completing ${String(actionable.length)} task${actionable.length !== 1 ? 's' : ''} first:`)}`
  );
  for (const node of actionable) {
    console.log(`    ${colors.muted('→')} ${colors.highlight(node.task.id)}  ${node.task.name}`);
  }
  log.newline();
}
