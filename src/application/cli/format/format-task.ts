/**
 * Plain-text formatters for task-shaped output. Pure — no I/O.
 */
import * as c from 'colorette';

import type { Task, TaskStatus } from '@src/domain/entities/task.ts';

const STATUS_COLOR: Record<TaskStatus, (s: string) => string> = {
  todo: c.dim,
  in_progress: c.yellow,
  done: c.green,
  blocked: c.red,
};

export function formatTaskStatus(status: TaskStatus): string {
  return STATUS_COLOR[status](status);
}

export function formatTaskLine(task: Task): string {
  const order = c.dim(`#${String(task.order)}`);
  const id = c.dim(task.id);
  const status = formatTaskStatus(task.status).padEnd(20);
  const blocked = task.blockedBy.length > 0 ? c.red(` blocked-by ${String(task.blockedBy.length)}`) : '';
  return `  ${order.padEnd(6)} ${id} ${status} ${task.name}${blocked}`;
}

export function formatTaskCard(task: Task): string {
  const lines: string[] = [];
  lines.push(c.bold(task.name));
  lines.push(`  ${c.dim('id        ')} ${task.id}`);
  lines.push(`  ${c.dim('status    ')} ${formatTaskStatus(task.status)}`);
  lines.push(`  ${c.dim('order     ')} ${String(task.order)}`);
  lines.push(`  ${c.dim('project   ')} ${task.projectPath}`);
  if (task.ticketId) {
    lines.push(`  ${c.dim('ticket    ')} ${task.ticketId}`);
  }
  if (task.description) {
    lines.push(`  ${c.dim('description')} ${task.description}`);
  }
  if (task.blockedBy.length > 0) {
    lines.push(`  ${c.dim('blockedBy ')} ${task.blockedBy.join(', ')}`);
  }
  if (task.steps.length > 0) {
    lines.push(`  ${c.dim('steps     ')}`);
    task.steps.forEach((s, i) => lines.push(`    ${String(i + 1)}. ${s}`));
  }
  if (task.verificationCriteria.length > 0) {
    lines.push(`  ${c.dim('criteria  ')}`);
    task.verificationCriteria.forEach((s) => lines.push(`    - ${s}`));
  }
  if (task.evaluated) {
    const status = task.evaluationStatus ?? 'unknown';
    const colored = status === 'passed' ? c.green(status) : c.red(status);
    lines.push(`  ${c.dim('evaluated ')} ${colored}`);
  }
  return lines.join('\n');
}
