import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@src/ai/session.ts', () => ({
  spawnInteractive: vi.fn(),
}));

vi.mock('@src/providers/index.ts', () => ({
  getActiveProvider: vi.fn(),
}));

import { writeFile } from 'node:fs/promises';
import { spawnInteractive } from '@src/ai/session.ts';
import { getActiveProvider } from '@src/providers/index.ts';
import type { Ticket } from '@src/schemas/index.ts';
import { formatTicketForPrompt, parseRequirementsFile, runAiSession } from './refine-utils.ts';

const mockWriteFile = vi.mocked(writeFile);
const mockSpawnInteractive = vi.mocked(spawnInteractive);
const mockGetActiveProvider = vi.mocked(getActiveProvider);

function createTicket(overrides: Partial<Ticket> & { title: string; projectName: string }): Ticket {
  return {
    id: 'abc12345',
    description: undefined,
    link: undefined,
    requirementStatus: 'pending',
    requirements: undefined,
    ...overrides,
  };
}

describe('formatTicketForPrompt', () => {
  it('includes ticket ID and title in header', () => {
    const ticket = createTicket({ id: 'abc12345', title: 'Add login page', projectName: 'app' });
    const result = formatTicketForPrompt(ticket);
    expect(result).toContain('[abc12345] Add login page');
  });

  it('includes project name', () => {
    const ticket = createTicket({ title: 'Fix bug', projectName: 'backend-api' });
    const result = formatTicketForPrompt(ticket);
    expect(result).toContain('Project: backend-api');
  });

  it('includes description when present', () => {
    const ticket = createTicket({
      title: 'Feature',
      projectName: 'app',
      description: 'This is the description.',
    });
    const result = formatTicketForPrompt(ticket);
    expect(result).toContain('**Description:**');
    expect(result).toContain('This is the description.');
  });

  it('includes link when present', () => {
    const ticket = createTicket({
      title: 'Feature',
      projectName: 'app',
      link: 'https://github.com/org/repo/issues/42',
    });
    const result = formatTicketForPrompt(ticket);
    expect(result).toContain('**Link:** https://github.com/org/repo/issues/42');
  });

  it('omits description section when description is not present', () => {
    const ticket = createTicket({ title: 'Feature', projectName: 'app', description: undefined });
    const result = formatTicketForPrompt(ticket);
    expect(result).not.toContain('**Description:**');
  });

  it('omits link section when link is not present', () => {
    const ticket = createTicket({ title: 'Feature', projectName: 'app', link: undefined });
    const result = formatTicketForPrompt(ticket);
    expect(result).not.toContain('**Link:**');
  });

  it('includes both description and link when both are present', () => {
    const ticket = createTicket({
      title: 'Feature',
      projectName: 'app',
      description: 'Do the thing.',
      link: 'https://example.com/issue/1',
    });
    const result = formatTicketForPrompt(ticket);
    expect(result).toContain('**Description:**');
    expect(result).toContain('Do the thing.');
    expect(result).toContain('**Link:** https://example.com/issue/1');
  });
});

describe('parseRequirementsFile', () => {
  it('parses a valid JSON array with requirements', () => {
    const content = JSON.stringify([
      { ref: 'T1', requirements: 'The system shall do X.' },
      { ref: 'T2', requirements: 'The system shall do Y.' },
    ]);

    const result = parseRequirementsFile(content);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ ref: 'T1', requirements: 'The system shall do X.' });
    expect(result[1]).toEqual({ ref: 'T2', requirements: 'The system shall do Y.' });
  });

  it('throws on invalid JSON', () => {
    expect(() => parseRequirementsFile('not valid json at all')).toThrow('No JSON array found in output');
  });

  it('throws on non-array JSON — plain object with no brackets', () => {
    // extractJsonArray throws "No JSON array found in output" when there is no '[' in the
    // input — the "Expected JSON array" guard inside parseRequirementsFile is never reached
    // because extractJsonArray fails first.
    const content = '{"ref": "T1", "requirements": "something"}';
    expect(() => parseRequirementsFile(content)).toThrow('No JSON array found in output');
  });

  it('throws on invalid schema — missing ref field', () => {
    const content = JSON.stringify([{ requirements: 'Some requirement' }]);
    expect(() => parseRequirementsFile(content)).toThrow('Invalid requirements format');
  });

  it('throws on invalid schema — missing requirements field', () => {
    const content = JSON.stringify([{ ref: 'T1' }]);
    expect(() => parseRequirementsFile(content)).toThrow('Invalid requirements format');
  });

  it('throws on invalid schema — empty ref string', () => {
    const content = JSON.stringify([{ ref: '', requirements: 'Some requirement' }]);
    expect(() => parseRequirementsFile(content)).toThrow('Invalid requirements format');
  });

  it('throws on invalid schema — empty requirements string', () => {
    const content = JSON.stringify([{ ref: 'T1', requirements: '' }]);
    expect(() => parseRequirementsFile(content)).toThrow('Invalid requirements format');
  });

  it('handles JSON array surrounded by text', () => {
    const content = `Here are the requirements:\n[{"ref": "T1", "requirements": "Do the thing."}]\nEnd of output.`;
    const result = parseRequirementsFile(content);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ ref: 'T1', requirements: 'Do the thing.' });
  });

  it('parses an empty array', () => {
    const content = '[]';
    const result = parseRequirementsFile(content);
    expect(result).toEqual([]);
  });
});

describe('runAiSession', () => {
  const fakeProvider = {
    binary: 'claude',
    baseArgs: [],
    buildInteractiveArgs: (prompt: string) => ['--', prompt],
    getSpawnEnv: () => ({}),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActiveProvider.mockResolvedValue(fakeProvider as unknown as Awaited<ReturnType<typeof getActiveProvider>>);
    mockSpawnInteractive.mockReturnValue({ code: 0 });
  });

  it('writes context file with the prompt content', async () => {
    await runAiSession('/tmp/sprint/refinement/ticket-1', 'Full prompt text here', 'Add login page');

    expect(mockWriteFile).toHaveBeenCalledOnce();
    const call = mockWriteFile.mock.calls[0] ?? [];
    expect(call[0]).toBe('/tmp/sprint/refinement/ticket-1/refine-context.md');
    expect(call[1]).toBe('Full prompt text here');
    expect(call[2]).toBe('utf-8');
  });

  it('calls spawnInteractive with the working directory', async () => {
    await runAiSession('/tmp/sprint/refinement/ticket-1', 'Some prompt', 'My Ticket');

    expect(mockSpawnInteractive).toHaveBeenCalledOnce();
    const call = mockSpawnInteractive.mock.calls[0] ?? [];
    expect((call[1] as { cwd: string }).cwd).toBe('/tmp/sprint/refinement/ticket-1');
  });

  it('calls spawnInteractive with a prompt referencing the ticket title', async () => {
    await runAiSession('/tmp/workdir', 'prompt content', 'Implement checkout flow');

    const startPrompt = (mockSpawnInteractive.mock.calls[0] ?? [])[0];
    expect(startPrompt).toContain('"Implement checkout flow"');
    expect(startPrompt).toContain('refine-context.md');
  });

  it('calls spawnInteractive with the resolved provider', async () => {
    await runAiSession('/tmp/workdir', 'prompt', 'Ticket Title');

    const provider = (mockSpawnInteractive.mock.calls[0] ?? [])[2];
    expect(provider).toBe(fakeProvider);
  });

  it('passes provider env vars to spawnInteractive', async () => {
    const providerWithEnv = {
      ...fakeProvider,
      getSpawnEnv: () => ({ CUSTOM_VAR: 'value' }),
    };
    mockGetActiveProvider.mockResolvedValue(
      providerWithEnv as unknown as Awaited<ReturnType<typeof getActiveProvider>>
    );

    await runAiSession('/tmp/workdir', 'prompt', 'Ticket Title');

    const call = mockSpawnInteractive.mock.calls[0] ?? [];
    expect((call[1] as { env: Record<string, string> }).env).toEqual({ CUSTOM_VAR: 'value' });
  });

  it('throws when spawnInteractive returns an error', async () => {
    mockSpawnInteractive.mockReturnValue({ code: 1, error: 'Provider binary not found' });

    await expect(runAiSession('/tmp/workdir', 'prompt', 'Ticket Title')).rejects.toThrow('Provider binary not found');
  });

  it('does not throw when spawnInteractive returns code 0 with no error', async () => {
    mockSpawnInteractive.mockReturnValue({ code: 0 });

    await expect(runAiSession('/tmp/workdir', 'prompt', 'Ticket Title')).resolves.toBeUndefined();
  });
});
