import { describe, expect, it } from 'vitest';

import { Sprint } from '../../../domain/entities/sprint.ts';
import { Ticket } from '../../../domain/entities/ticket.ts';
import { StorageError } from '../../../domain/errors/storage-error.ts';
import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { IsoTimestamp } from '../../../domain/values/iso-timestamp.ts';
import { ProjectName } from '../../../domain/values/project-name.ts';
import { Slug } from '../../../domain/values/slug.ts';
import { TicketId } from '../../../domain/values/ticket-id.ts';
import { FakeAiSessionPort } from '../../_test-fakes/fake-ai-session-port.ts';
import { FakeLoggerPort } from '../../_test-fakes/fake-logger-port.ts';
import { FakePromptBuilderPort } from '../../_test-fakes/fake-prompt-builder-port.ts';
import { RefineSingleTicketUseCase } from './refine-single-ticket.ts';

const T0 = '2026-04-29T14:15:22.000Z' as IsoTimestamp;

function slug(s: string): Slug {
  const r = Slug.parse(s);
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function projectName(): ProjectName {
  const r = ProjectName.parse('demo');
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function cwd(): AbsolutePath {
  const r = AbsolutePath.parse('/tmp/ralphctl-test');
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function newSprint(): Sprint {
  const s = Sprint.create({ name: 'A', slug: slug('a'), now: T0 });
  if (!s.ok) throw new Error('precondition failed');
  return s.value;
}

function pendingTicket(): Ticket {
  const tid = TicketId.parse('aaaaaaaa');
  if (!tid.ok) throw new Error('precondition failed');
  const t = Ticket.create({ id: tid.value, title: 'Initial title', projectName: projectName() });
  if (!t.ok) throw new Error('precondition failed');
  return t.value;
}

describe('RefineSingleTicketUseCase', () => {
  it('refines a pending ticket and returns it approved', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: 'must do X' } }],
    });
    const prompts = new FakePromptBuilderPort();
    const logger = new FakeLoggerPort();
    const uc = new RefineSingleTicketUseCase(ai, prompts, logger);

    const result = await uc.execute({
      sprint: newSprint(),
      ticket: pendingTicket(),
      cwd: cwd(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ticket.requirementStatus).toBe('approved');
    expect(result.value.ticket.requirements).toBe('must do X');
    expect(result.value.rawAiOutput).toBe('must do X');
  });

  it('passes the built prompt to the AI session', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: 'reqs' } }],
    });
    const prompts = new FakePromptBuilderPort();
    const uc = new RefineSingleTicketUseCase(ai, prompts, new FakeLoggerPort());

    const ticket = pendingTicket();
    await uc.execute({ sprint: newSprint(), ticket, cwd: cwd() });

    expect(prompts.refineCalls).toHaveLength(1);
    expect(prompts.refineCalls[0]?.ticket.id).toBe(ticket.id);
    expect(ai.captured).toHaveLength(1);
    expect(ai.captured[0]?.prompt).toContain('refine:');
    expect(ai.captured[0]?.prompt).toContain(ticket.id);
    expect(ai.captured[0]?.options.cwd).toBe(cwd());
  });

  it('strips a leading "Here is" preamble before approving', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: 'Here is the refined result:\nThe app must do X.' } }],
    });
    const uc = new RefineSingleTicketUseCase(ai, new FakePromptBuilderPort(), new FakeLoggerPort());

    const result = await uc.execute({ sprint: newSprint(), ticket: pendingTicket(), cwd: cwd() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ticket.requirements).toBe('The app must do X.');
  });

  it('empty AI output approves the ticket with empty requirements (use case accepts it)', async () => {
    // Legacy intent: document behavior when AI returns empty output — use case
    // defers validation to the caller; it approves with empty text.
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: '' } }],
    });
    const uc = new RefineSingleTicketUseCase(ai, new FakePromptBuilderPort(), new FakeLoggerPort());

    const result = await uc.execute({ sprint: newSprint(), ticket: pendingTicket(), cwd: cwd() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The use case approves with an empty string; callers that require non-empty
    // requirements should validate the output before persisting.
    expect(result.value.ticket.requirementStatus).toBe('approved');
    expect(result.value.ticket.requirements).toBe('');
    expect(result.value.rawAiOutput).toBe('');
  });

  it('rejects refinement on an already-approved ticket', async () => {
    const ticket = pendingTicket();
    const approved = ticket.approveRequirements('first');
    if (!approved.ok) throw new Error('precondition failed');

    const ai = new FakeAiSessionPort();
    const uc = new RefineSingleTicketUseCase(ai, new FakePromptBuilderPort(), new FakeLoggerPort());

    const result = await uc.execute({ sprint: newSprint(), ticket: approved.value, cwd: cwd() });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-state');
      if (result.error.code === 'invalid-state') {
        expect(result.error.entity).toBe('ticket');
        expect(result.error.attemptedAction).toBe('refine');
      }
    }
    expect(ai.captured).toHaveLength(0);
  });

  it('propagates a StorageError surfaced by the prompt builder', async () => {
    const failure = new StorageError({ subCode: 'io', message: 'template missing' });
    const ai = new FakeAiSessionPort();
    const prompts = new FakePromptBuilderPort({ failWith: failure });
    const uc = new RefineSingleTicketUseCase(ai, prompts, new FakeLoggerPort());

    const result = await uc.execute({ sprint: newSprint(), ticket: pendingTicket(), cwd: cwd() });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('storage-error');
    }
    expect(ai.captured).toHaveLength(0);
  });

  it('propagates an AI session failure', async () => {
    const failure = new StorageError({ subCode: 'io', message: 'spawn failed' });
    const ai = new FakeAiSessionPort({ outcomes: [{ kind: 'error', error: failure }] });
    const uc = new RefineSingleTicketUseCase(ai, new FakePromptBuilderPort(), new FakeLoggerPort());

    const result = await uc.execute({ sprint: newSprint(), ticket: pendingTicket(), cwd: cwd() });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('storage-error');
    }
  });

  it('forwards the abort signal to the AI session', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: 'reqs' } }],
    });
    const uc = new RefineSingleTicketUseCase(ai, new FakePromptBuilderPort(), new FakeLoggerPort());
    const ac = new AbortController();

    await uc.execute({
      sprint: newSprint(),
      ticket: pendingTicket(),
      cwd: cwd(),
      abortSignal: ac.signal,
    });

    expect(ai.captured[0]?.options.abortSignal).toBe(ac.signal);
  });
});
