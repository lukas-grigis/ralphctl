import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sprint, Ticket } from '@src/domain/models.ts';
import type { PromptPort } from '@src/business/ports/prompt.ts';
import { mkdir, readFile } from 'node:fs/promises';
import { assertSprintStatus, getSprint, resolveSprintId, saveSprint } from '@src/integration/persistence/sprint.ts';
import { selectTicket } from '@src/integration/cli/commands/shared/selectors.ts';
import { fileExists } from '@src/integration/persistence/storage.ts';
import { fetchIssueFromUrl, formatIssueContext } from '@src/integration/external/issue-fetch.ts';
import { exitWithCode } from '@src/domain/exit-codes.ts';
import { formatTicketForPrompt, parseRequirementsFile, runAiSession } from './refine-utils.ts';
import { buildTicketRefinePrompt } from '@src/integration/ai/prompts/loader.ts';
import { createSpinner, showError, showWarning } from '@src/integration/ui/theme/ui.ts';
import { getRefinementDir } from '@src/integration/persistence/paths.ts';
import { providerDisplayName, resolveProvider } from '@src/integration/external/provider.ts';

// --- Module mocks (must be at top level) ---

vi.mock('@src/integration/persistence/sprint.ts', () => ({
  resolveSprintId: vi.fn(),
  getSprint: vi.fn(),
  assertSprintStatus: vi.fn(),
  saveSprint: vi.fn(),
}));

vi.mock('@src/integration/persistence/ticket.ts', () => ({
  formatTicketDisplay: vi.fn((t: Ticket) => `[${t.id}] ${t.title}`),
}));

vi.mock('@src/integration/cli/commands/shared/selectors.ts', () => ({
  selectTicket: vi.fn(),
}));

vi.mock('@src/integration/external/provider.ts', () => ({
  resolveProvider: vi.fn().mockResolvedValue('claude'),
  providerDisplayName: vi.fn().mockReturnValue('Claude'),
}));

vi.mock('@src/integration/persistence/storage.ts', () => ({
  fileExists: vi.fn(),
}));

vi.mock('@src/integration/external/issue-fetch.ts', () => ({
  fetchIssueFromUrl: vi.fn(),
  formatIssueContext: vi.fn(),
  IssueFetchError: class IssueFetchError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'IssueFetchError';
    }
  },
}));

vi.mock('@src/integration/persistence/paths.ts', () => ({
  getRefinementDir: vi.fn().mockReturnValue('/tmp/refine-dir'),
}));

vi.mock('@src/domain/exit-codes.ts', () => ({
  exitWithCode: vi.fn(),
  EXIT_ERROR: 1,
  EXIT_SUCCESS: 0,
  EXIT_NO_TASKS: 2,
  EXIT_ALL_BLOCKED: 3,
  EXIT_INTERRUPTED: 130,
}));

vi.mock('./refine-utils.ts', () => ({
  formatTicketForPrompt: vi.fn().mockReturnValue('## Ticket content\n'),
  parseRequirementsFile: vi.fn(),
  runAiSession: vi.fn(),
}));

vi.mock('@src/integration/ai/prompts/loader.ts', () => ({
  buildTicketRefinePrompt: vi.fn().mockReturnValue('prompt text'),
}));

const confirmMock = vi.fn();
const inputMock = vi.fn();
const selectMock = vi.fn();
const checkboxMock = vi.fn();
const editorMock = vi.fn();
const fileBrowserMock = vi.fn();

const promptMock: PromptPort = {
  confirm: confirmMock,
  input: inputMock,
  select: selectMock,
  checkbox: checkboxMock,
  editor: editorMock,
  fileBrowser: fileBrowserMock,
};

vi.mock('@src/integration/bootstrap.ts', () => ({
  getPrompt: vi.fn(() => promptMock),
}));

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(),
}));

vi.mock('@src/integration/ui/theme/ui.ts', () => ({
  createSpinner: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    succeed: vi.fn(),
    fail: vi.fn(),
  })),
  emoji: { donut: '🍩' },
  field: vi.fn((label: string, value: string) => `${label}: ${value}`),
  fieldMultiline: vi.fn((label: string, value: string) => `${label}: ${value}`),
  icons: { ticket: '🎫' },
  log: {
    newline: vi.fn(),
    dim: vi.fn(),
  },
  printHeader: vi.fn(),
  renderCard: vi.fn().mockReturnValue('rendered card'),
  showError: vi.fn(),
  showSuccess: vi.fn(),
  showTip: vi.fn(),
  showWarning: vi.fn(),
}));

// --- Imports after mocks ---

// --- Test helpers ---

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 'ticket-123',
    title: 'My Feature',
    requirementStatus: 'approved',
    requirements: 'Existing requirements text',
    ...overrides,
  };
}

function makeSprint(tickets: Ticket[] = [], overrides: Partial<Sprint> = {}): Sprint {
  return {
    id: '20240101-120000-test',
    name: 'Test Sprint',
    projectId: 'prj00001',
    status: 'draft',
    createdAt: '2024-01-01T12:00:00Z',
    activatedAt: null,
    closedAt: null,
    tickets,
    checkRanAt: {},
    branch: null,
    ...overrides,
  };
}

/** Set up mocks for a successful full-flow run through the AI session. */
function setupSuccessfulFlow(ticketOverrides: Partial<Ticket> = {}): { ticket: Ticket; sprint: Sprint } {
  const ticket = makeTicket(ticketOverrides);
  const sprint = makeSprint([ticket]);

  vi.mocked(getSprint).mockResolvedValue(sprint);
  vi.mocked(readFile).mockImplementation((path: unknown) =>
    Promise.resolve(
      String(path).endsWith('.schema.json')
        ? '{}'
        : JSON.stringify([{ ref: ticket.id, requirements: '## New Requirements\nDone.' }])
    )
  );
  vi.mocked(fileExists).mockResolvedValue(true);
  vi.mocked(parseRequirementsFile).mockReturnValue([{ ref: ticket.id, requirements: '## New Requirements\nDone.' }]);
  vi.mocked(runAiSession).mockResolvedValue(undefined);

  return { ticket, sprint };
}

// --- Tests ---

describe('ticketRefineCommand', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.resetAllMocks();

    // Suppress console output
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    // Re-establish prompt port mock after reset
    const { getPrompt } = await import('@src/integration/bootstrap.ts');
    vi.mocked(getPrompt).mockReturnValue(promptMock);

    // Re-establish stable defaults after reset
    vi.mocked(resolveSprintId).mockResolvedValue('20240101-120000-test');
    vi.mocked(assertSprintStatus).mockReturnValue(undefined);
    vi.mocked(saveSprint).mockResolvedValue(undefined);
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(fileExists).mockResolvedValue(false);
    vi.mocked(formatTicketForPrompt).mockReturnValue('## Ticket content\n');
    vi.mocked(buildTicketRefinePrompt).mockReturnValue('prompt text');
    vi.mocked(getRefinementDir).mockReturnValue('/tmp/refine-dir');
    vi.mocked(resolveProvider).mockResolvedValue('claude');
    vi.mocked(providerDisplayName).mockReturnValue('Claude');

    // Restore spinner factory mock after reset
    vi.mocked(createSpinner).mockReturnValue({
      start: vi.fn(),
      stop: vi.fn(),
      succeed: vi.fn(),
      fail: vi.fn(),
    } as unknown as ReturnType<typeof createSpinner>);
  });

  afterEach(() => {
    (consoleSpy as { mockRestore: () => void }).mockRestore();
  });

  describe('sprint resolution failures', () => {
    it('shows warning when no current sprint is set', async () => {
      vi.mocked(resolveSprintId).mockRejectedValue(new Error('No current sprint'));

      const { ticketRefineCommand } = await import('./refine.ts');
      await ticketRefineCommand();

      expect(vi.mocked(showWarning)).toHaveBeenCalledWith('No current sprint set.');
    });

    it('shows error when sprint is not draft', async () => {
      const sprint = makeSprint([makeTicket()], { status: 'active' });
      vi.mocked(getSprint).mockResolvedValue(sprint);
      vi.mocked(assertSprintStatus).mockImplementation(() => {
        throw new Error("Sprint cannot 'refine ticket' — must be one of: draft (is: active)");
      });

      const { ticketRefineCommand } = await import('./refine.ts');
      await ticketRefineCommand('ticket-123');

      expect(vi.mocked(showError)).toHaveBeenCalledWith(expect.stringContaining('refine ticket'));
    });
  });

  describe('ticket selection and validation', () => {
    it('shows warning when no approved tickets exist', async () => {
      const sprint = makeSprint([makeTicket({ requirementStatus: 'pending' })]);
      vi.mocked(getSprint).mockResolvedValue(sprint);

      const { ticketRefineCommand } = await import('./refine.ts');
      await ticketRefineCommand();

      expect(vi.mocked(showWarning)).toHaveBeenCalledWith('No approved tickets to re-refine.');
    });

    it('calls selectTicket in interactive mode when no ticketId provided', async () => {
      const sprint = makeSprint([makeTicket()]);
      vi.mocked(getSprint).mockResolvedValue(sprint);
      vi.mocked(selectTicket).mockResolvedValue(null);

      const { ticketRefineCommand } = await import('./refine.ts');
      await ticketRefineCommand(undefined, { interactive: true });

      expect(vi.mocked(selectTicket)).toHaveBeenCalledWith('Select ticket to re-refine:', expect.any(Function));
    });

    it('selectTicket filter function accepts only approved tickets', async () => {
      const sprint = makeSprint([makeTicket()]);
      vi.mocked(getSprint).mockResolvedValue(sprint);

      let capturedFilter: ((t: Ticket) => boolean) | undefined;
      vi.mocked(selectTicket).mockImplementation((_prompt, filter) => {
        capturedFilter = filter;
        return Promise.resolve(null);
      });

      const { ticketRefineCommand } = await import('./refine.ts');
      await ticketRefineCommand(undefined, { interactive: true });

      expect(capturedFilter).toBeDefined();
      expect(capturedFilter?.(makeTicket({ requirementStatus: 'approved' }))).toBe(true);
      expect(capturedFilter?.(makeTicket({ requirementStatus: 'pending' }))).toBe(false);
    });

    it('shows error when ticket not found by id', async () => {
      const sprint = makeSprint([makeTicket()]);
      vi.mocked(getSprint).mockResolvedValue(sprint);

      const { ticketRefineCommand } = await import('./refine.ts');
      await ticketRefineCommand('nonexistent-id');

      expect(vi.mocked(showError)).toHaveBeenCalledWith('Ticket not found: nonexistent-id');
    });

    it('shows error when ticket exists but is not approved', async () => {
      // Sprint must have at least one approved ticket (to pass the "no approved tickets" guard),
      // but the target ticket being looked up by ID is pending.
      const pendingTicket = makeTicket({ id: 'ticket-pending', requirementStatus: 'pending' });
      const otherApprovedTicket = makeTicket({ id: 'ticket-approved', requirementStatus: 'approved' });
      const sprint = makeSprint([pendingTicket, otherApprovedTicket]);
      vi.mocked(getSprint).mockResolvedValue(sprint);

      const { ticketRefineCommand } = await import('./refine.ts');
      await ticketRefineCommand('ticket-pending');

      expect(vi.mocked(showError)).toHaveBeenCalledWith(
        expect.stringContaining('Only approved tickets can be re-refined')
      );
    });
  });

  describe('successful re-refinement flow', () => {
    it('runs AI session, parses output, and saves on approval', async () => {
      const { sprint } = setupSuccessfulFlow();
      confirmMock
        .mockResolvedValueOnce(true) // "Start session?"
        .mockResolvedValueOnce(true); // "Approve requirements?"

      const { ticketRefineCommand } = await import('./refine.ts');
      await ticketRefineCommand('ticket-123');

      expect(vi.mocked(runAiSession)).toHaveBeenCalled();
      expect(vi.mocked(parseRequirementsFile)).toHaveBeenCalled();
      expect(vi.mocked(saveSprint)).toHaveBeenCalledWith(sprint);
    });

    it('does not save when user declines approval of requirements', async () => {
      setupSuccessfulFlow();
      confirmMock
        .mockResolvedValueOnce(true) // "Start session?"
        .mockResolvedValueOnce(false); // "Approve requirements?" — declined

      const { ticketRefineCommand } = await import('./refine.ts');
      await ticketRefineCommand('ticket-123');

      expect(vi.mocked(runAiSession)).toHaveBeenCalled();
      expect(vi.mocked(saveSprint)).not.toHaveBeenCalled();
    });

    it('does not run AI session when user declines start confirmation', async () => {
      const sprint = makeSprint([makeTicket()]);
      vi.mocked(getSprint).mockResolvedValue(sprint);
      confirmMock.mockResolvedValueOnce(false);

      const { ticketRefineCommand } = await import('./refine.ts');
      await ticketRefineCommand('ticket-123');

      expect(vi.mocked(runAiSession)).not.toHaveBeenCalled();
      expect(vi.mocked(saveSprint)).not.toHaveBeenCalled();
    });

    it('shows warning when no requirements file produced by AI session', async () => {
      setupSuccessfulFlow();
      vi.mocked(fileExists).mockResolvedValue(false);
      confirmMock.mockResolvedValueOnce(true);

      const { ticketRefineCommand } = await import('./refine.ts');
      await ticketRefineCommand('ticket-123');

      expect(vi.mocked(showWarning)).toHaveBeenCalledWith('No requirements file found from AI session.');
      expect(vi.mocked(saveSprint)).not.toHaveBeenCalled();
    });

    it('shows error when requirements file cannot be parsed', async () => {
      setupSuccessfulFlow();
      vi.mocked(parseRequirementsFile).mockImplementation(() => {
        throw new Error('Invalid JSON');
      });
      confirmMock.mockResolvedValueOnce(true);

      const { ticketRefineCommand } = await import('./refine.ts');
      await ticketRefineCommand('ticket-123');

      expect(vi.mocked(showError)).toHaveBeenCalledWith(expect.stringContaining('Failed to parse requirements file'));
      expect(vi.mocked(saveSprint)).not.toHaveBeenCalled();
    });

    it('shows warning when no requirements found in output', async () => {
      setupSuccessfulFlow();
      vi.mocked(parseRequirementsFile).mockReturnValue([]);
      confirmMock.mockResolvedValueOnce(true);

      const { ticketRefineCommand } = await import('./refine.ts');
      await ticketRefineCommand('ticket-123');

      expect(vi.mocked(showWarning)).toHaveBeenCalledWith('No requirements found in output file.');
      expect(vi.mocked(saveSprint)).not.toHaveBeenCalled();
    });

    it('shows warning when requirement ref does not match ticket', async () => {
      setupSuccessfulFlow();
      vi.mocked(parseRequirementsFile).mockReturnValue([
        { ref: 'some-other-ticket', requirements: 'Requirements for wrong ticket' },
      ]);
      confirmMock.mockResolvedValueOnce(true);

      const { ticketRefineCommand } = await import('./refine.ts');
      await ticketRefineCommand('ticket-123');

      expect(vi.mocked(showWarning)).toHaveBeenCalledWith('Requirement reference does not match this ticket.');
      expect(vi.mocked(saveSprint)).not.toHaveBeenCalled();
    });

    it('includes previously approved requirements in the prompt content', async () => {
      setupSuccessfulFlow({ requirements: 'Old requirements text' });
      confirmMock.mockResolvedValueOnce(true).mockResolvedValueOnce(true);

      const { ticketRefineCommand } = await import('./refine.ts');
      await ticketRefineCommand('ticket-123');

      // The first arg to buildTicketRefinePrompt is the combined ticket content
      const promptContentArg = vi.mocked(buildTicketRefinePrompt).mock.calls[0]?.[0];
      expect(promptContentArg).toContain('Previously Approved Requirements');
      expect(promptContentArg).toContain('Old requirements text');
    });
  });

  describe('issue link fetching', () => {
    it('fetches issue data when ticket has a link and passes context to prompt builder', async () => {
      const { ticket } = setupSuccessfulFlow({ link: 'https://github.com/owner/repo/issues/42' });

      const issueData = {
        title: 'Issue title',
        body: 'Issue body',
        comments: [{ author: 'user', body: 'a comment' }],
      };
      vi.mocked(fetchIssueFromUrl).mockReturnValue(issueData as ReturnType<typeof fetchIssueFromUrl>);
      vi.mocked(formatIssueContext).mockReturnValue('## Issue Context\ncomment here');

      confirmMock.mockResolvedValueOnce(true).mockResolvedValueOnce(true);

      const { ticketRefineCommand } = await import('./refine.ts');
      await ticketRefineCommand('ticket-123');

      expect(vi.mocked(fetchIssueFromUrl)).toHaveBeenCalledWith(ticket.link);
      expect(vi.mocked(formatIssueContext)).toHaveBeenCalledWith(issueData);

      // Issue context is the 4th argument to buildTicketRefinePrompt
      const issueContextArg = vi.mocked(buildTicketRefinePrompt).mock.calls[0]?.[3];
      expect(issueContextArg).toBe('## Issue Context\ncomment here');
    });

    it('continues without issue context when fetch throws IssueFetchError', async () => {
      const { IssueFetchError } = await import('@src/integration/external/issue-fetch.ts');

      setupSuccessfulFlow({ link: 'https://github.com/owner/repo/issues/99' });

      vi.mocked(fetchIssueFromUrl).mockImplementation(() => {
        throw new IssueFetchError('Could not fetch issue');
      });

      confirmMock.mockResolvedValueOnce(true).mockResolvedValueOnce(true);

      const { ticketRefineCommand } = await import('./refine.ts');
      await ticketRefineCommand('ticket-123');

      // Session still runs — fetch failure is non-fatal
      expect(vi.mocked(runAiSession)).toHaveBeenCalled();

      // Issue context arg passed to buildTicketRefinePrompt should be empty
      const issueContextArg = vi.mocked(buildTicketRefinePrompt).mock.calls[0]?.[3];
      expect(issueContextArg).toBe('');
    });
  });

  describe('non-interactive mode', () => {
    it('calls exitWithCode when ticket ID is missing in non-interactive mode', async () => {
      const sprint = makeSprint([makeTicket()]);
      vi.mocked(getSprint).mockResolvedValue(sprint);
      vi.mocked(exitWithCode).mockImplementation((): never => {
        throw new Error('process.exit called');
      });

      const { ticketRefineCommand } = await import('./refine.ts');
      await expect(ticketRefineCommand(undefined, { interactive: false })).rejects.toThrow('process.exit called');

      expect(vi.mocked(exitWithCode)).toHaveBeenCalledWith(1);
    });
  });
});
