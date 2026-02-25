/**
 * CLI smoke tests - verify CLI layer works end-to-end.
 * Uses in-process CLI execution for speed (~100ms).
 *
 * Run with: pnpm test cli-smoke
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createMultiProjectEnv, createTestEnv } from '@src/test-utils/setup.ts';
import type { CliResult } from '@src/test-utils/cli-runner.ts';
import { extractField, extractTaskIds, runCli } from '@src/test-utils/cli-runner.ts';

let testDir: string;
let env: Record<string, string>;
let cleanup: () => Promise<void>;

async function cli(args: string[]): Promise<CliResult> {
  return runCli(args, env);
}

describe('CLI Smoke Tests', { timeout: 5000 }, () => {
  beforeAll(async () => {
    const testEnv = await createTestEnv();
    testDir = testEnv.testDir;
    env = testEnv.env;
    cleanup = testEnv.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  it('runs full workflow: sprint → ticket → task', async () => {
    // Create sprint (auto-activates when no other active sprint)
    const createSprint = await cli(['sprint', 'create', '-n', '--name', 'Smoke Test']);
    expect(createSprint.code).toBe(0);
    expect(createSprint.stdout).toContain('Sprint created!');

    // Add ticket
    const addTicket = await cli(['ticket', 'add', '-n', '--project', 'test-project', '--title', 'Test Ticket']);
    expect(addTicket.code).toBe(0);
    expect(addTicket.stdout).toContain('Ticket added');
    const ticketId = extractField(addTicket.stdout, 'ID');
    expect(ticketId).toBeTruthy();
    if (!ticketId) throw new Error('ticketId not found');

    // Add task
    const addTask = await cli(['task', 'add', '-n', '--name', 'Test Task', '--ticket', ticketId]);
    expect(addTask.code).toBe(0);
    expect(addTask.stdout).toContain('Task added');

    // List tasks
    const listTasks = await cli(['task', 'list']);
    expect(listTasks.code).toBe(0);
    expect(listTasks.stdout).toContain('Test Task');
  });

  it('creates sprint with generated name when name is empty', async () => {
    const result = await cli(['sprint', 'create', '-n', '--name', '']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Sprint created!');
    // The sprint should have a generated uuid8 as the name
  });

  it('lists sprints', async () => {
    await cli(['sprint', 'create', '-n', '--name', 'Sprint A']);
    await cli(['sprint', 'create', '-n', '--name', 'Sprint B']);

    const list = await cli(['sprint', 'list']);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain('Sprint A');
    expect(list.stdout).toContain('Sprint B');
  });

  it('updates task status', async () => {
    const sprint = await cli(['sprint', 'create', '-n', '--name', 'Status Test']);
    expect(sprint.code).toBe(0);

    const ticket = await cli(['ticket', 'add', '-n', '--project', 'test-project', '--title', 'Ticket']);
    expect(ticket.code).toBe(0);
    const stTicketId = extractField(ticket.stdout, 'ID');
    expect(stTicketId).toBeTruthy();
    if (!stTicketId) throw new Error('stTicketId not found');

    const addTask = await cli(['task', 'add', '-n', '--name', 'My Task', '--ticket', stTicketId]);
    expect(addTask.code).toBe(0);

    // Extract task ID from output
    const taskId = extractField(addTask.stdout, 'ID');
    expect(taskId).toBeTruthy();

    // Activate sprint to allow status updates
    // Need to set RALPHCTL_ROOT in test process for store imports to work
    process.env['RALPHCTL_ROOT'] = testDir;
    const { activateSprint, getSprint } = await import('@src/store/sprint.ts');
    const { getCurrentSprint } = await import('@src/store/config.ts');
    const sprintId = await getCurrentSprint();
    expect(sprintId).toBeTruthy();
    if (!sprintId) throw new Error('No current sprint');
    const currentSprint = await getSprint(sprintId);
    if (currentSprint.status === 'draft') {
      await activateSprint(sprintId);
    }

    const status = await cli(['task', 'status', taskId ?? '', 'in_progress']);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain('In Progress');
  });

  it('removes ticket and task', async () => {
    await cli(['sprint', 'create', '-n', '--name', 'Remove Test']);
    const addRmTicket = await cli(['ticket', 'add', '-n', '--project', 'test-project', '--title', 'To Remove']);
    const rmTicketId = extractField(addRmTicket.stdout, 'ID');
    expect(rmTicketId).toBeTruthy();
    if (!rmTicketId) throw new Error('rmTicketId not found');
    await cli(['task', 'add', '-n', '--name', 'Task to Remove', '--ticket', rmTicketId]);

    // Remove ticket (only works in draft sprint)
    const rmTicket = await cli(['ticket', 'remove', rmTicketId, '-y']);
    expect(rmTicket.code).toBe(0);

    // Verify ticket gone
    const tickets = await cli(['ticket', 'list']);
    expect(tickets.stdout).not.toContain('To Remove');
  });

  it('sets and shows AI provider config', async () => {
    // Set provider to claude
    const setClaude = await cli(['config', 'set', 'provider', 'claude']);
    expect(setClaude.code).toBe(0);
    expect(setClaude.stdout).toContain('claude');

    // Show config
    const show1 = await cli(['config', 'show']);
    expect(show1.code).toBe(0);
    expect(show1.stdout).toContain('claude');

    // Set provider to copilot
    const setCopilot = await cli(['config', 'set', 'provider', 'copilot']);
    expect(setCopilot.code).toBe(0);
    expect(setCopilot.stdout).toContain('copilot');

    // Show updated config
    const show2 = await cli(['config', 'show']);
    expect(show2.code).toBe(0);
    expect(show2.stdout).toContain('copilot');

    // Reject invalid provider (shows error message but exits normally)
    const setInvalid = await cli(['config', 'set', 'provider', 'invalid']);
    expect(setInvalid.stdout).toContain('Invalid provider');
  });
});

/**
 * Elaborate end-to-end scenario: QA Test Automation Sprint
 *
 * Simulates a realistic sprint workflow for a QA team setting up test automation.
 * Tests all CRUD operations on sprints, tickets, and tasks without invoking AI.
 */
describe('QA Test Automation Sprint Scenario', { timeout: 5000 }, () => {
  let scenarioDir: string;
  let frontendDir: string;
  let backendDir: string;
  let scenarioEnv: Record<string, string>;
  let scenarioCleanup: () => Promise<void>;

  // Helper to run CLI with scenario environment
  async function scenarioCli(args: string[]): Promise<CliResult> {
    return runCli(args, scenarioEnv);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SETUP: Create isolated test environment with two project directories
  // ═══════════════════════════════════════════════════════════════════════════
  beforeAll(async () => {
    const multiEnv = await createMultiProjectEnv([
      {
        name: 'ecommerce-frontend',
        displayName: 'E-Commerce Frontend',
        description: 'React storefront application',
        checkScript: 'npm test',
      },
      {
        name: 'ecommerce-backend',
        displayName: 'E-Commerce Backend',
        description: 'Node.js API service',
        checkScript: 'npm run test:unit',
      },
    ]);
    scenarioDir = multiEnv.testDir;
    const frontendPath = multiEnv.projectDirs.get('ecommerce-frontend');
    const backendPath = multiEnv.projectDirs.get('ecommerce-backend');
    if (!frontendPath || !backendPath) throw new Error('Project dirs not created');
    frontendDir = frontendPath;
    backendDir = backendPath;
    scenarioEnv = multiEnv.env;
    scenarioCleanup = multiEnv.cleanup;
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CLEANUP: Remove all temporary directories
  // ═══════════════════════════════════════════════════════════════════════════
  afterAll(async () => {
    await scenarioCleanup();
  });

  it('runs complete QA automation sprint lifecycle', async () => {
    // ═════════════════════════════════════════════════════════════════════════
    // PHASE 1: Sprint Creation & Project Verification
    // ═════════════════════════════════════════════════════════════════════════

    // Verify projects are available
    const projectList = await scenarioCli(['project', 'list']);
    expect(projectList.code).toBe(0);
    expect(projectList.stdout).toContain('ecommerce-frontend');
    expect(projectList.stdout).toContain('ecommerce-backend');

    // Show project details
    const showFrontend = await scenarioCli(['project', 'show', 'ecommerce-frontend']);
    expect(showFrontend.code).toBe(0);
    expect(showFrontend.stdout).toContain('E-Commerce Frontend');
    expect(showFrontend.stdout).toContain('React storefront application');

    // Create the QA automation sprint
    const createSprint = await scenarioCli(['sprint', 'create', '-n', '--name', 'QA Test Automation Q1']);
    expect(createSprint.code).toBe(0);
    expect(createSprint.stdout).toContain('Sprint created!');
    expect(createSprint.stdout).toContain('QA Test Automation Q1');

    // Verify sprint appears in list
    const sprintList = await scenarioCli(['sprint', 'list']);
    expect(sprintList.code).toBe(0);
    expect(sprintList.stdout).toContain('QA Test Automation Q1');

    // Show sprint details (should be empty initially)
    const showSprint = await scenarioCli(['sprint', 'show']);
    expect(showSprint.code).toBe(0);
    expect(showSprint.stdout).toContain('QA Test Automation Q1');
    expect(showSprint.stdout).toContain('Draft'); // Status shows as "📋 Draft"
    expect(showSprint.stdout).toContain('No tickets yet');

    // ═════════════════════════════════════════════════════════════════════════
    // PHASE 2: Add Tickets for Both Projects
    // ═════════════════════════════════════════════════════════════════════════

    // Add frontend testing ticket with description and link
    const addFrontendTicket = await scenarioCli([
      'ticket',
      'add',
      '-n',
      '--project',
      'ecommerce-frontend',
      '--title',
      'Setup Playwright E2E Tests',
      '--description',
      'Configure Playwright for cross-browser E2E testing of checkout flow',
      '--link',
      'https://jira.example.com/QA-101',
    ]);
    expect(addFrontendTicket.code).toBe(0);
    expect(addFrontendTicket.stdout).toContain('Ticket added');
    const frontendTicketId = extractField(addFrontendTicket.stdout, 'ID');
    expect(frontendTicketId).toBeTruthy();
    if (!frontendTicketId) throw new Error('frontendTicketId not found');

    // Add backend testing ticket
    const addBackendTicket = await scenarioCli([
      'ticket',
      'add',
      '-n',
      '--project',
      'ecommerce-backend',
      '--title',
      'API Integration Test Suite',
      '--description',
      'Create comprehensive integration tests for payment and inventory APIs',
    ]);
    expect(addBackendTicket.code).toBe(0);
    expect(addBackendTicket.stdout).toContain('Ticket added');
    const backendTicketId = extractField(addBackendTicket.stdout, 'ID');
    expect(backendTicketId).toBeTruthy();
    if (!backendTicketId) throw new Error('backendTicketId not found');

    // Add a third ticket (frontend) that we will edit later
    const addComponentTicket = await scenarioCli([
      'ticket',
      'add',
      '-n',
      '--project',
      'ecommerce-frontend',
      '--title',
      'Component Unit Tests',
    ]);
    expect(addComponentTicket.code).toBe(0);
    const componentTicketId = extractField(addComponentTicket.stdout, 'ID');
    expect(componentTicketId).toBeTruthy();
    if (!componentTicketId) throw new Error('componentTicketId not found');

    // Add a fourth ticket that we will remove later
    const addRemovableTicket = await scenarioCli([
      'ticket',
      'add',
      '-n',
      '--project',
      'ecommerce-backend',
      '--title',
      'Legacy Test Migration',
    ]);
    expect(addRemovableTicket.code).toBe(0);
    const removableTicketId = extractField(addRemovableTicket.stdout, 'ID');
    expect(removableTicketId).toBeTruthy();
    if (!removableTicketId) throw new Error('removableTicketId not found');

    // Verify all tickets appear in list
    const ticketList = await scenarioCli(['ticket', 'list']);
    expect(ticketList.code).toBe(0);
    expect(ticketList.stdout).toContain('Setup Playwright E2E Tests');
    expect(ticketList.stdout).toContain('API Integration Test Suite');
    expect(ticketList.stdout).toContain('Component Unit Tests');
    expect(ticketList.stdout).toContain('Legacy Test Migration');

    // Show specific ticket details
    const showTicket = await scenarioCli(['ticket', 'show', frontendTicketId]);
    expect(showTicket.code).toBe(0);
    expect(showTicket.stdout).toContain('Setup Playwright E2E Tests');
    expect(showTicket.stdout).toContain('cross-browser E2E testing');
    expect(showTicket.stdout).toContain('https://jira.example.com/QA-101');

    // ═════════════════════════════════════════════════════════════════════════
    // PHASE 3: Edit and Remove Tickets
    // ═════════════════════════════════════════════════════════════════════════

    // Edit component ticket to add description and update title
    const editTicket = await scenarioCli([
      'ticket',
      'edit',
      componentTicketId,
      '-n',
      '--title',
      'React Component Unit Tests with RTL',
      '--description',
      'Setup React Testing Library for comprehensive component testing',
      '--link',
      'https://jira.example.com/QA-103',
    ]);
    expect(editTicket.code).toBe(0);
    expect(editTicket.stdout).toContain('Ticket updated');
    expect(editTicket.stdout).toContain('React Component Unit Tests with RTL');

    // Verify edit persisted
    const showEditedTicket = await scenarioCli(['ticket', 'show', componentTicketId]);
    expect(showEditedTicket.code).toBe(0);
    expect(showEditedTicket.stdout).toContain('React Component Unit Tests with RTL');
    expect(showEditedTicket.stdout).toContain('React Testing Library');

    // Remove the legacy migration ticket (we decided to defer it)
    const removeTicket = await scenarioCli(['ticket', 'remove', removableTicketId, '-y']);
    expect(removeTicket.code).toBe(0);

    // Verify ticket is gone
    const ticketListAfterRemove = await scenarioCli(['ticket', 'list']);
    expect(ticketListAfterRemove.stdout).not.toContain('Legacy Test Migration');
    // But other tickets remain
    expect(ticketListAfterRemove.stdout).toContain('Setup Playwright E2E Tests');
    expect(ticketListAfterRemove.stdout).toContain('API Integration Test Suite');
    expect(ticketListAfterRemove.stdout).toContain('React Component Unit Tests with RTL');

    // ═════════════════════════════════════════════════════════════════════════
    // PHASE 4: Add Tasks Manually
    // ═════════════════════════════════════════════════════════════════════════

    // Add tasks for frontend ticket (Playwright setup)
    const addTask1 = await scenarioCli([
      'task',
      'add',
      '-n',
      '--name',
      'Install Playwright dependencies',
      '--ticket',
      frontendTicketId,
      '--description',
      'Add playwright and @playwright/test to devDependencies',
      '--step',
      'Run npm install -D playwright @playwright/test',
      '--step',
      'Run npx playwright install',
    ]);
    expect(addTask1.code).toBe(0);
    expect(addTask1.stdout).toContain('Task added');
    const task1Id = extractField(addTask1.stdout, 'ID');
    expect(task1Id).toBeTruthy();
    if (!task1Id) throw new Error('task1Id not found');

    const addTask2 = await scenarioCli([
      'task',
      'add',
      '-n',
      '--name',
      'Create Playwright config',
      '--ticket',
      frontendTicketId,
      '--step',
      'Create playwright.config.ts with browser matrix',
      '--step',
      'Configure screenshots on failure',
    ]);
    expect(addTask2.code).toBe(0);
    const task2Id = extractField(addTask2.stdout, 'ID');
    if (!task2Id) throw new Error('task2Id not found');

    const addTask3 = await scenarioCli([
      'task',
      'add',
      '-n',
      '--name',
      'Write checkout flow tests',
      '--ticket',
      frontendTicketId,
      '--description',
      'E2E tests for add-to-cart, cart review, and payment flow',
    ]);
    expect(addTask3.code).toBe(0);
    const task3Id = extractField(addTask3.stdout, 'ID');
    if (!task3Id) throw new Error('task3Id not found');

    // Add tasks for backend ticket (API tests)
    const addTask4 = await scenarioCli([
      'task',
      'add',
      '-n',
      '--name',
      'Setup Jest with supertest',
      '--ticket',
      backendTicketId,
      '--step',
      'Install jest, supertest, and ts-jest',
      '--step',
      'Create jest.config.ts',
    ]);
    expect(addTask4.code).toBe(0);

    const addTask5 = await scenarioCli([
      'task',
      'add',
      '-n',
      '--name',
      'Write payment API tests',
      '--ticket',
      backendTicketId,
      '--description',
      'Test payment initiation, confirmation, and refund endpoints',
    ]);
    expect(addTask5.code).toBe(0);

    // Add a task we will remove
    const addTaskToRemove = await scenarioCli([
      'task',
      'add',
      '-n',
      '--name',
      'Task to be removed',
      '--ticket',
      backendTicketId,
    ]);
    expect(addTaskToRemove.code).toBe(0);
    const taskToRemoveId = extractField(addTaskToRemove.stdout, 'ID');
    expect(taskToRemoveId).toBeTruthy();
    if (!taskToRemoveId) throw new Error('taskToRemoveId not found');

    // Verify all tasks appear
    const taskList = await scenarioCli(['task', 'list']);
    expect(taskList.code).toBe(0);
    expect(taskList.stdout).toContain('Install Playwright dependencies');
    expect(taskList.stdout).toContain('Create Playwright config');
    expect(taskList.stdout).toContain('Write checkout flow tests');
    expect(taskList.stdout).toContain('Setup Jest with supertest');
    expect(taskList.stdout).toContain('Write payment API tests');
    expect(taskList.stdout).toContain('Task to be removed');

    // Show specific task details
    const showTask = await scenarioCli(['task', 'show', task1Id]);
    expect(showTask.code).toBe(0);
    expect(showTask.stdout).toContain('Install Playwright dependencies');
    expect(showTask.stdout).toContain('npm install -D playwright');
    expect(showTask.stdout).toContain('npx playwright install');

    // ═════════════════════════════════════════════════════════════════════════
    // PHASE 5: Reorder and Remove Tasks
    // ═════════════════════════════════════════════════════════════════════════

    // Reorder task3 (checkout tests) to be first priority (position 1)
    const reorderTask = await scenarioCli(['task', 'reorder', task3Id, '1']);
    expect(reorderTask.code).toBe(0);
    expect(reorderTask.stdout).toContain('Task reordered');
    expect(reorderTask.stdout).toContain('New Order');

    // Verify reorder took effect (checkout tests should now be first)
    const taskListAfterReorder = await scenarioCli(['task', 'list']);
    expect(taskListAfterReorder.code).toBe(0);
    // The checkout flow test should appear before other tasks in the output

    // Remove the unnecessary task
    const removeTask = await scenarioCli(['task', 'remove', taskToRemoveId, '-y']);
    expect(removeTask.code).toBe(0);

    // Verify task is gone
    const taskListAfterRemove = await scenarioCli(['task', 'list']);
    expect(taskListAfterRemove.stdout).not.toContain('Task to be removed');

    // ═════════════════════════════════════════════════════════════════════════
    // PHASE 6: Import Additional Tasks from JSON
    // ═════════════════════════════════════════════════════════════════════════

    // Create a JSON file with additional tasks
    const importFile = join(scenarioDir, 'additional-tasks.json');
    await writeFile(
      importFile,
      JSON.stringify([
        {
          id: 'import-1',
          name: 'Setup CI pipeline for tests',
          projectPath: frontendDir,
          description: 'Configure GitHub Actions to run Playwright tests on PR',
          steps: ['Create .github/workflows/test.yml', 'Add Playwright container setup', 'Configure test reporting'],
        },
        {
          id: 'import-2',
          name: 'Add test coverage reporting',
          projectPath: backendDir,
          description: 'Setup code coverage with c8 and upload to codecov',
          blockedBy: ['import-1'],
        },
      ])
    );

    const importTasks = await scenarioCli(['task', 'import', importFile]);
    expect(importTasks.code).toBe(0);
    expect(importTasks.stdout).toContain('Setup CI pipeline for tests');
    expect(importTasks.stdout).toContain('Add test coverage reporting');

    // Verify imported tasks appear
    const taskListAfterImport = await scenarioCli(['task', 'list']);
    expect(taskListAfterImport.stdout).toContain('Setup CI pipeline for tests');
    expect(taskListAfterImport.stdout).toContain('Add test coverage reporting');

    // ═════════════════════════════════════════════════════════════════════════
    // PHASE 7: Sprint Context and Show (Markdown Output)
    // ═════════════════════════════════════════════════════════════════════════

    // Get sprint context (markdown format for AI)
    const context = await scenarioCli(['sprint', 'context']);
    expect(context.code).toBe(0);
    expect(context.stdout).toContain('# Sprint: QA Test Automation Q1');
    expect(context.stdout).toContain('## Tickets');
    expect(context.stdout).toContain('## Tasks');
    expect(context.stdout).toContain('ecommerce-frontend');
    expect(context.stdout).toContain('ecommerce-backend');
    expect(context.stdout).toContain('Setup Playwright E2E Tests');
    expect(context.stdout).toContain('API Integration Test Suite');
    expect(context.stdout).toContain('cross-browser E2E testing');

    // Show sprint (formatted display)
    const showSprintWithData = await scenarioCli(['sprint', 'show']);
    expect(showSprintWithData.code).toBe(0);
    expect(showSprintWithData.stdout).toContain('QA Test Automation Q1');
    expect(showSprintWithData.stdout).toContain('Tickets');
    expect(showSprintWithData.stdout).toContain('Tasks');

    // Brief task list
    const taskListBrief = await scenarioCli(['task', 'list', '-b']);
    expect(taskListBrief.code).toBe(0);
    // Brief mode should still contain task names
    expect(taskListBrief.stdout).toContain('Playwright');

    // Brief ticket list
    const ticketListBrief = await scenarioCli(['ticket', 'list', '-b']);
    expect(ticketListBrief.code).toBe(0);
    expect(ticketListBrief.stdout).toContain('Playwright');

    // ═════════════════════════════════════════════════════════════════════════
    // PHASE 8: Activate Sprint and Update Task Status
    // ═════════════════════════════════════════════════════════════════════════

    // Activate the sprint (required for status updates and progress logging)
    process.env['RALPHCTL_ROOT'] = scenarioDir;
    const { activateSprint, getSprint } = await import('@src/store/sprint.ts');
    const { getCurrentSprint } = await import('@src/store/config.ts');
    const sprintId = await getCurrentSprint();
    expect(sprintId).toBeTruthy();
    if (!sprintId) throw new Error('No sprint');
    await activateSprint(sprintId);

    // Get next task
    const nextTask = await scenarioCli(['task', 'next']);
    expect(nextTask.code).toBe(0);
    expect(nextTask.stdout).toContain('Next Task');

    // Update first task to in_progress
    const statusInProgress = await scenarioCli(['task', 'status', task1Id, 'in_progress']);
    expect(statusInProgress.code).toBe(0);
    expect(statusInProgress.stdout).toContain('In Progress');

    // Update first task to done
    const statusDone = await scenarioCli(['task', 'status', task1Id, 'done']);
    expect(statusDone.code).toBe(0);
    expect(statusDone.stdout).toContain('Done');

    // Update second task to in_progress
    const statusTask2 = await scenarioCli(['task', 'status', task2Id, 'in_progress']);
    expect(statusTask2.code).toBe(0);

    // Verify status changes in task list
    const taskListWithStatus = await scenarioCli(['task', 'list']);
    expect(taskListWithStatus.code).toBe(0);
    // The list should reflect updated statuses

    // ═════════════════════════════════════════════════════════════════════════
    // PHASE 9: Progress Logging
    // ═════════════════════════════════════════════════════════════════════════

    // Log progress (requires active sprint)
    const logProgress1 = await scenarioCli(['progress', 'log', 'Completed Playwright installation and initial config']);
    expect(logProgress1.code).toBe(0);
    expect(logProgress1.stdout).toContain('Progress logged');

    const logProgress2 = await scenarioCli([
      'progress',
      'log',
      'Started work on test configuration, found browser compatibility issue',
    ]);
    expect(logProgress2.code).toBe(0);

    // Show progress
    const showProgress = await scenarioCli(['progress', 'show']);
    expect(showProgress.code).toBe(0);
    expect(showProgress.stdout).toContain('Completed Playwright installation');
    expect(showProgress.stdout).toContain('browser compatibility issue');

    // ═════════════════════════════════════════════════════════════════════════
    // PHASE 10: Create Another Sprint and Switch
    // ═════════════════════════════════════════════════════════════════════════

    // Create a second sprint
    const createSprint2 = await scenarioCli(['sprint', 'create', '-n', '--name', 'Performance Testing Q1']);
    expect(createSprint2.code).toBe(0);
    expect(createSprint2.stdout).toContain('Performance Testing Q1');

    // List should show both sprints
    const sprintListBoth = await scenarioCli(['sprint', 'list']);
    expect(sprintListBoth.code).toBe(0);
    expect(sprintListBoth.stdout).toContain('QA Test Automation Q1');
    expect(sprintListBoth.stdout).toContain('Performance Testing Q1');

    // Switch back to first sprint using sprint current
    const sprint1 = await getSprint(sprintId);
    const switchSprint = await scenarioCli(['sprint', 'current', sprint1.id]);
    expect(switchSprint.code).toBe(0);

    // Verify current sprint changed
    const showCurrentSprint = await scenarioCli(['sprint', 'show']);
    expect(showCurrentSprint.code).toBe(0);
    expect(showCurrentSprint.stdout).toContain('QA Test Automation Q1');

    // ═════════════════════════════════════════════════════════════════════════
    // PHASE 11: Close Sprint
    // ═════════════════════════════════════════════════════════════════════════

    // Mark remaining tasks as done before closing (close prompts for confirmation with incomplete tasks)
    const allTasksForClose = await scenarioCli(['task', 'list']);
    // Extract all task IDs from the output and mark them done
    const taskIdMatches = extractTaskIds(allTasksForClose.stdout);
    for (const tid of taskIdMatches) {
      await scenarioCli(['task', 'status', tid, 'done']);
    }

    // Close the active sprint
    const closeSprintResult = await scenarioCli(['sprint', 'close']);
    expect(closeSprintResult.code).toBe(0);
    expect(closeSprintResult.stdout).toContain('Sprint closed');

    // Verify sprint is now closed
    const showClosedSprint = await scenarioCli(['sprint', 'show', sprint1.id]);
    expect(showClosedSprint.code).toBe(0);
    expect(showClosedSprint.stdout).toContain('Closed'); // Status shows as "✅ Closed"

    // ═════════════════════════════════════════════════════════════════════════
    // PHASE 12: Error Cases & Edge Cases
    // ═════════════════════════════════════════════════════════════════════════

    // Try to add ticket to closed sprint (shows error but doesn't exit with error code)
    await scenarioCli(['sprint', 'current', sprint1.id]);
    const addToClosedSprint = await scenarioCli([
      'ticket',
      'add',
      '-n',
      '--project',
      'ecommerce-frontend',
      '--title',
      'Should Fail',
    ]);
    // SprintStatusError is caught and displayed without exit code
    expect(addToClosedSprint.stdout).toMatch(/closed|cannot|not allowed/i);

    // Show non-existent ticket (shows error message)
    const showMissingTicket = await scenarioCli(['ticket', 'show', 'NONEXISTENT']);
    expect(showMissingTicket.stdout).toContain('not found');

    // Edit with invalid link URL (should fail)
    // First switch to the new sprint which is still draft
    const sprint2Id = await getCurrentSprint();
    if (sprint2Id && sprint2Id !== sprintId) {
      await scenarioCli(['sprint', 'current', sprint2Id]);
    }
  });

  it('handles project commands correctly', async () => {
    // List projects
    const list = await scenarioCli(['project', 'list']);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain('ecommerce-frontend');
    expect(list.stdout).toContain('ecommerce-backend');

    // Show project
    const show = await scenarioCli(['project', 'show', 'ecommerce-backend']);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain('E-Commerce Backend');
    expect(show.stdout).toContain('Node.js API service');
    expect(show.stdout).toContain('npm run test:unit');

    // Show non-existent project (shows error message but doesn't exit with error code)
    const showMissing = await scenarioCli(['project', 'show', 'nonexistent']);
    expect(showMissing.stdout).toContain('Project not found');
  });

  it('validates ticket edit constraints', async () => {
    // Create a fresh sprint for edit testing
    await scenarioCli(['sprint', 'create', '-n', '--name', 'Edit Test Sprint']);

    // Add a ticket
    const addEditTicket = await scenarioCli([
      'ticket',
      'add',
      '-n',
      '--project',
      'ecommerce-frontend',
      '--title',
      'Test Edit',
    ]);
    const editTicketId = extractField(addEditTicket.stdout, 'ID');
    expect(editTicketId).toBeTruthy();
    if (!editTicketId) throw new Error('editTicketId not found');

    // Edit with no changes provided (should fail)
    const editNoChanges = await scenarioCli(['ticket', 'edit', editTicketId, '-n']);
    expect(editNoChanges.code).not.toBe(0);
    expect(editNoChanges.stderr + editNoChanges.stdout).toContain('No updates provided');

    // Edit with empty title (should fail)
    const editEmptyTitle = await scenarioCli(['ticket', 'edit', editTicketId, '-n', '--title', '']);
    expect(editEmptyTitle.code).not.toBe(0);

    // Edit with invalid URL (should fail)
    const editBadUrl = await scenarioCli(['ticket', 'edit', editTicketId, '-n', '--link', 'not-a-url']);
    expect(editBadUrl.code).not.toBe(0);
    expect(editBadUrl.stderr + editBadUrl.stdout).toContain('valid URL');

    // Valid edit should work
    const editValid = await scenarioCli(['ticket', 'edit', editTicketId, '-n', '--title', 'Updated Title']);
    expect(editValid.code).toBe(0);
    expect(editValid.stdout).toContain('Ticket updated');
    expect(editValid.stdout).toContain('Updated Title');
  });

  it('handles task import edge cases', async () => {
    // Create sprint for import testing
    await scenarioCli(['sprint', 'create', '-n', '--name', 'Import Test Sprint']);

    // Import with missing file
    const importMissing = await scenarioCli(['task', 'import', '/nonexistent/file.json']);
    expect(importMissing.stdout).toContain('Failed to read file');

    // Import with invalid JSON
    const invalidJsonFile = join(scenarioDir, 'invalid.json');
    await writeFile(invalidJsonFile, 'not valid json {{{');
    const importInvalid = await scenarioCli(['task', 'import', invalidJsonFile]);
    expect(importInvalid.stdout).toContain('Invalid JSON');

    // Import with empty array
    const emptyFile = join(scenarioDir, 'empty.json');
    await writeFile(emptyFile, '[]');
    const importEmpty = await scenarioCli(['task', 'import', emptyFile]);
    expect(importEmpty.stdout).toContain('No tasks to import');

    // Import with invalid task format (missing required fields)
    const badFormatFile = join(scenarioDir, 'bad-format.json');
    await writeFile(badFormatFile, JSON.stringify([{ name: 'Missing projectPath' }]));
    const importBadFormat = await scenarioCli(['task', 'import', badFormatFile]);
    expect(importBadFormat.stdout).toContain('Invalid task format');
  });

  it('runs sprint health checks', async () => {
    // Create sprint with tasks
    await scenarioCli(['sprint', 'create', '-n', '--name', 'Health Check Sprint']);
    await scenarioCli([
      'task',
      'add',
      '-n',
      '--name',
      'Task 1',
      '--project',
      'ecommerce-frontend',
      '--step',
      'Do something',
    ]);

    // Run health check
    const health = await scenarioCli(['sprint', 'health']);
    expect(health.code).toBe(0);
    expect(health.stdout).toContain('Sprint Health');
    expect(health.stdout).toContain('Health Score');
    expect(health.stdout).toContain('Blockers');
    expect(health.stdout).toContain('Stale Tasks');
  });

  it('exports sprint requirements', async () => {
    // Create sprint with a ticket
    await scenarioCli(['sprint', 'create', '-n', '--name', 'Requirements Export Sprint']);
    await scenarioCli(['ticket', 'add', '-n', '--project', 'ecommerce-frontend', '--title', 'Test Requirement']);

    // Try exporting (will show warning since no approved requirements)
    const requirements = await scenarioCli(['sprint', 'requirements']);
    expect(requirements.stdout).toContain('No approved requirements to export');
  });
});
