import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { confirm } from '@inquirer/prompts';
import { addSingleTicketInteractive } from '@src/commands/ticket/add.ts';
import { getCurrentSprint } from '@src/store/config.ts';
import { getSprint } from '@src/store/sprint.ts';
import { runWizard } from './wizard.ts';

vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn(),
}));

vi.mock('@src/commands/sprint/create.ts', () => ({
  sprintCreateCommand: vi.fn(),
}));

vi.mock('@src/commands/ticket/add.ts', () => ({
  addSingleTicketInteractive: vi.fn(),
}));

vi.mock('@src/commands/sprint/refine.ts', () => ({
  sprintRefineCommand: vi.fn(),
}));

vi.mock('@src/commands/sprint/plan.ts', () => ({
  sprintPlanCommand: vi.fn(),
}));

vi.mock('@src/commands/sprint/start.ts', () => ({
  sprintStartCommand: vi.fn(),
}));

vi.mock('@src/store/config.ts', () => ({
  getCurrentSprint: vi.fn(),
}));

vi.mock('@src/store/sprint.ts', () => ({
  getSprint: vi.fn(),
}));

const confirmMock = vi.mocked(confirm);
const addTicketMock = vi.mocked(addSingleTicketInteractive);
const getSprintMock = vi.mocked(getSprint);

describe('runWizard — ticket loop', () => {
  beforeEach(() => {
    vi.mocked(getCurrentSprint).mockResolvedValue('test-sprint');
    getSprintMock.mockResolvedValue({
      id: 'test-sprint',
      name: 'Test Sprint',
      status: 'draft',
      createdAt: new Date().toISOString(),
      activatedAt: null,
      closedAt: null,
      tickets: [],
      checkRanAt: {},
      branch: null,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('exits ticket loop without re-prompting when addSingleTicketInteractive returns null', async () => {
    addTicketMock.mockResolvedValue(null);
    confirmMock.mockResolvedValue(false);

    await runWizard();

    expect(addTicketMock).toHaveBeenCalledTimes(1);

    const confirmMessages = confirmMock.mock.calls.map((call) => (call[0] as { message: string }).message);
    expect(confirmMessages).not.toContainEqual(expect.stringContaining('Add another ticket'));
  });

  it('continues ticket loop when tickets are added successfully', async () => {
    addTicketMock
      .mockResolvedValueOnce({
        id: 'abc12345',
        title: 'Test ticket',
        projectName: 'my-project',
        requirementStatus: 'pending',
      })
      .mockResolvedValueOnce({
        id: 'def67890',
        title: 'Another ticket',
        projectName: 'my-project',
        requirementStatus: 'pending',
      });

    // "Add another ticket?" → yes, then no; "Start execution?" → no
    confirmMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValueOnce(false);

    getSprintMock.mockResolvedValue({
      id: 'test-sprint',
      name: 'Test Sprint',
      status: 'draft',
      createdAt: new Date().toISOString(),
      activatedAt: null,
      closedAt: null,
      tickets: [
        { id: 'abc12345', title: 'Test ticket', projectName: 'my-project', requirementStatus: 'pending' },
        { id: 'def67890', title: 'Another ticket', projectName: 'my-project', requirementStatus: 'pending' },
      ],
      checkRanAt: {},
      branch: null,
    });

    await runWizard();

    expect(addTicketMock).toHaveBeenCalledTimes(2);
  });
});
