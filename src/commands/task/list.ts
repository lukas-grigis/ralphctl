import { colors } from '@src/theme/index.ts';
import { listTasks } from '@src/store/task.ts';
import { TaskStatusSchema } from '@src/schemas/index.ts';
import { badge, formatTaskStatus, icons, log, printHeader, renderTable, showEmpty, showError } from '@src/theme/ui.ts';

interface TaskListFilters {
  brief: boolean;
  statusFilter?: string;
  projectFilter?: string;
  ticketFilter?: string;
  blockedOnly: boolean;
}

function parseListArgs(args: string[]): TaskListFilters {
  const result: TaskListFilters = {
    brief: false,
    blockedOnly: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '-b' || arg === '--brief') result.brief = true;
    else if (arg === '--status' && next) {
      result.statusFilter = next;
      i++;
    } else if (arg === '--project' && next) {
      result.projectFilter = next;
      i++;
    } else if (arg === '--ticket' && next) {
      result.ticketFilter = next;
      i++;
    } else if (arg === '--blocked') result.blockedOnly = true;
  }
  return result;
}

function buildFilterSummary(filters: TaskListFilters): string {
  const parts: string[] = [];
  if (filters.statusFilter) parts.push(`status=${filters.statusFilter}`);
  if (filters.projectFilter) parts.push(`project=${filters.projectFilter}`);
  if (filters.ticketFilter) parts.push(`ticket=${filters.ticketFilter}`);
  if (filters.blockedOnly) parts.push('blocked');
  return parts.length > 0 ? ` (filtered: ${parts.join(', ')})` : '';
}

export async function taskListCommand(args: string[] = []): Promise<void> {
  const { brief, statusFilter, projectFilter, ticketFilter, blockedOnly } = parseListArgs(args);

  // Validate status filter
  if (statusFilter) {
    const result = TaskStatusSchema.safeParse(statusFilter);
    if (!result.success) {
      showError(`Invalid status: "${statusFilter}". Valid values: todo, in_progress, done`);
      return;
    }
  }

  const tasks = await listTasks();

  if (tasks.length === 0) {
    showEmpty('tasks', 'Add one with: ralphctl task add');
    return;
  }

  // Apply filters
  let filtered = tasks;
  if (statusFilter) filtered = filtered.filter((t) => t.status === statusFilter);
  if (projectFilter) filtered = filtered.filter((t) => t.projectPath.includes(projectFilter));
  if (ticketFilter) filtered = filtered.filter((t) => t.ticketId === ticketFilter);
  if (blockedOnly) filtered = filtered.filter((t) => t.blockedBy.length > 0);

  const filterStr = buildFilterSummary({ brief, statusFilter, projectFilter, ticketFilter, blockedOnly });
  const isFiltered = filtered.length !== tasks.length;

  if (filtered.length === 0) {
    showEmpty('matching tasks', 'Try adjusting your filters');
    return;
  }

  if (brief) {
    // Brief mode: one line per task
    const countLabel = isFiltered ? `${String(filtered.length)} of ${String(tasks.length)}` : String(tasks.length);
    console.log(`\n# Tasks (${countLabel})${filterStr}\n`);
    for (const task of filtered) {
      const ticketRef = task.ticketId ? ` [${task.ticketId}]` : '';
      const blockedRef = task.blockedBy.length > 0 ? ` (blocked by: ${task.blockedBy.join(', ')})` : '';
      console.log(
        `- ${String(task.order)}. **[${task.status}]** ${task.id}: ${task.name} (${task.projectPath})${ticketRef}${blockedRef}`
      );
    }
    console.log('');
    return;
  }

  // Interactive list with table
  const tasksByStatus = {
    todo: filtered.filter((t) => t.status === 'todo').length,
    in_progress: filtered.filter((t) => t.status === 'in_progress').length,
    done: filtered.filter((t) => t.status === 'done').length,
  };

  printHeader(`Tasks (${String(filtered.length)})`, icons.task);

  // Status summary
  log.raw(
    `${formatTaskStatus('todo')} ${String(tasksByStatus.todo)}   ` +
      `${formatTaskStatus('in_progress')} ${String(tasksByStatus.in_progress)}   ` +
      `${formatTaskStatus('done')} ${String(tasksByStatus.done)}`
  );
  log.newline();

  const rows: string[][] = filtered.map((task) => {
    const statusIcon =
      task.status === 'done' ? icons.success : task.status === 'in_progress' ? icons.active : icons.inactive;
    const statusColor = task.status === 'done' ? 'success' : task.status === 'in_progress' ? 'warning' : 'muted';
    const blocked = task.blockedBy.length > 0 ? colors.error('(blocked)') : '';
    return [badge(statusIcon, statusColor), String(task.order), task.name, task.id, blocked];
  });

  console.log(
    renderTable(
      [
        { header: '', minWidth: 0 },
        { header: '#', align: 'right' },
        { header: 'Name' },
        { header: 'ID' },
        { header: '' },
      ],
      rows
    )
  );

  // Progress summary
  const percent = filtered.length > 0 ? Math.round((tasksByStatus.done / filtered.length) * 100) : 0;
  const progressColor = percent === 100 ? colors.success : percent > 50 ? colors.warning : colors.muted;
  const showingLabel = isFiltered
    ? `Showing ${String(filtered.length)} of ${String(tasks.length)} task(s)${filterStr}`
    : `Showing ${String(tasks.length)} task(s)`;
  log.newline();
  log.dim(
    `Progress: ${progressColor(`${String(tasksByStatus.done)}/${String(filtered.length)} (${String(percent)}%)`)}  |  ${showingLabel}`
  );
  log.newline();
}
