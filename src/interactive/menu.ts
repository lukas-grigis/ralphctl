import { Separator } from '@inquirer/prompts';

/**
 * Menu structure definitions for interactive mode
 */

interface Choice {
  name: string;
  value: string;
  description?: string;
}

type SeparatorInstance = InstanceType<typeof Separator>;

export type MenuItem = Choice | SeparatorInstance;

export interface SubMenu {
  title: string;
  items: MenuItem[];
}

// Main menu - clean with subtle separators
export const mainMenuItems: MenuItem[] = [
  { name: 'Project', value: 'project', description: 'Manage projects' },
  new Separator(),
  { name: 'Sprint', value: 'sprint', description: 'Manage sprints' },
  { name: 'Ticket', value: 'ticket', description: 'Manage tickets' },
  { name: 'Task', value: 'task', description: 'Manage tasks' },
  { name: 'Progress', value: 'progress', description: 'Log progress' },
  new Separator(),
  { name: 'Exit', value: 'exit', description: 'Goodbye!' },
];

// Submenus
export const subMenus: Record<string, SubMenu> = {
  project: {
    title: 'Project',
    items: [
      { name: 'Add', value: 'add', description: 'Add a new project' },
      { name: 'List', value: 'list', description: 'List all projects' },
      { name: 'Show', value: 'show', description: 'Show project details' },
      { name: 'Remove', value: 'remove', description: 'Remove a project' },
      new Separator(),
      { name: 'Add Repository', value: 'repo add', description: 'Add repository to project' },
      { name: 'Remove Repository', value: 'repo remove', description: 'Remove repository' },
      new Separator(),
      { name: 'Back', value: 'back', description: 'Return to main menu' },
    ],
  },
  sprint: {
    title: 'Sprint',
    items: [
      { name: 'Create', value: 'create', description: 'Create a new sprint' },
      { name: 'List', value: 'list', description: 'List all sprints' },
      { name: 'Show', value: 'show', description: 'Show sprint details' },
      { name: 'Context', value: 'context', description: 'Output full sprint context' },
      { name: 'Set Current', value: 'current', description: 'Set current sprint' },
      new Separator(),
      { name: 'Refine', value: 'refine', description: 'Refine ticket specs' },
      { name: 'Plan', value: 'plan', description: 'Generate tasks' },
      new Separator(),
      { name: 'Start', value: 'start', description: 'Start implementation' },
      { name: 'Close', value: 'close', description: 'Close sprint' },
      new Separator(),
      { name: 'Back', value: 'back', description: 'Return to main menu' },
    ],
  },
  ticket: {
    title: 'Ticket',
    items: [
      { name: 'Add', value: 'add', description: 'Add a ticket' },
      { name: 'List', value: 'list', description: 'List all tickets' },
      { name: 'Show', value: 'show', description: 'Show ticket details' },
      { name: 'Remove', value: 'remove', description: 'Remove a ticket' },
      new Separator(),
      { name: 'Back', value: 'back', description: 'Return to main menu' },
    ],
  },
  task: {
    title: 'Task',
    items: [
      { name: 'Add', value: 'add', description: 'Add a new task' },
      { name: 'Import', value: 'import', description: 'Import from JSON' },
      { name: 'List', value: 'list', description: 'List all tasks' },
      { name: 'Show', value: 'show', description: 'Show task details' },
      new Separator(),
      { name: 'Status', value: 'status', description: 'Update status' },
      { name: 'Next', value: 'next', description: 'Get next task' },
      { name: 'Reorder', value: 'reorder', description: 'Change priority' },
      { name: 'Remove', value: 'remove', description: 'Remove a task' },
      new Separator(),
      { name: 'Back', value: 'back', description: 'Return to main menu' },
    ],
  },
  progress: {
    title: 'Progress',
    items: [
      { name: 'Log', value: 'log', description: 'Log progress entry' },
      { name: 'Show', value: 'show', description: 'Show progress log' },
      new Separator(),
      { name: 'Back', value: 'back', description: 'Return to main menu' },
    ],
  },
};
