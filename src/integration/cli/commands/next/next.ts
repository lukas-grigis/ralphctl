import { getNextAction, loadDashboardData, type NextAction } from '@src/integration/ui/tui/views/dashboard-data.ts';
import { colors } from '@src/integration/ui/theme/theme.ts';
import { formatSprintStatus, icons, log } from '@src/integration/ui/theme/ui.ts';

interface NextOptions {
  porcelain?: boolean;
  json?: boolean;
}

interface NextPayload {
  sprint: { id: string; name: string; status: 'draft' | 'active' | 'closed' } | null;
  action: { command: string; label: string; description: string } | null;
  reason: 'no-sprint' | 'all-done' | 'action-ready' | 'sprint-closed';
}

function toCommand(action: NextAction): string {
  return `ralphctl ${action.group} ${action.subCommand}`;
}

function computePayload(data: Awaited<ReturnType<typeof loadDashboardData>>): NextPayload {
  if (!data) {
    return { sprint: null, action: null, reason: 'no-sprint' };
  }

  const sprint = { id: data.sprint.id, name: data.sprint.name, status: data.sprint.status };

  if (data.sprint.status === 'closed') {
    return { sprint, action: null, reason: 'sprint-closed' };
  }

  const next = getNextAction(data);
  if (!next) {
    return { sprint, action: null, reason: 'all-done' };
  }

  return {
    sprint,
    action: { command: toCommand(next), label: next.label, description: next.description },
    reason: 'action-ready',
  };
}

function renderPorcelain(payload: NextPayload): void {
  // Single line, zero chrome. Empty string means "nothing to do".
  if (payload.action) {
    console.log(payload.action.command);
    return;
  }
  console.log('');
}

function renderHuman(payload: NextPayload): void {
  log.newline();

  if (payload.reason === 'no-sprint') {
    console.log(`  ${colors.muted(icons.inactive)} ${colors.muted('No current sprint.')}`);
    console.log(`  ${colors.muted(icons.tip)} ${colors.muted('Create one to get started:')}`);
    console.log(`    ${colors.highlight('ralphctl sprint create')}`);
    log.newline();
    return;
  }

  if (!payload.sprint) return; // exhaustive safety, not reachable

  const sprintLine = `${icons.sprint} ${colors.highlight(payload.sprint.name)}  ${formatSprintStatus(payload.sprint.status)}`;
  console.log(`  ${sprintLine}`);

  if (payload.reason === 'sprint-closed') {
    console.log(`  ${colors.muted(icons.info)} ${colors.muted('Sprint is closed. Start a new one:')}`);
    console.log(`    ${colors.highlight('ralphctl sprint create')}`);
    log.newline();
    return;
  }

  if (payload.reason === 'all-done') {
    console.log(`  ${colors.success(icons.success)} ${colors.success('Nothing left to do.')}`);
    log.newline();
    return;
  }

  const action = payload.action;
  if (!action) return;

  console.log(`  ${colors.muted(icons.tip)} ${colors.muted(action.label + ':')} ${colors.muted(action.description)}`);
  console.log(`    ${colors.highlight(action.command)}`);
  log.newline();
}

export async function nextCommand(options: NextOptions = {}): Promise<void> {
  const data = await loadDashboardData();
  const payload = computePayload(data);

  if (options.json) {
    console.log(JSON.stringify(payload));
    return;
  }

  if (options.porcelain) {
    renderPorcelain(payload);
    return;
  }

  renderHuman(payload);
}
