import { describe, expect, it } from 'vitest';

import { Sprint } from '@src/domain/entities/sprint.ts';
import { Ticket } from '@src/domain/entities/ticket.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { Slug } from '@src/domain/values/slug.ts';
import { TicketId } from '@src/domain/values/ticket-id.ts';
import { FakeAiSessionPort } from '@src/business/_test-fakes/fake-ai-session-port.ts';
import { FakeLoggerPort } from '@src/business/_test-fakes/fake-logger-port.ts';
import { FakePromptBuilderPort } from '@src/business/_test-fakes/fake-prompt-builder-port.ts';
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
  const s = Sprint.create({ name: 'A', slug: slug('a'), now: T0, projectName: projectName() });
  if (!s.ok) throw new Error('precondition failed');
  return s.value;
}

function pendingTicket(): Ticket {
  const tid = TicketId.parse('aaaaaaaa');
  if (!tid.ok) throw new Error('precondition failed');
  const t = Ticket.create({ id: tid.value, title: 'Initial title' });
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

  it('parses a JSON array reply and uses the matching ticket entry', async () => {
    // The prompt template instructs Claude to write a JSON array of
    // { ref, requirements } entries — the parser picks the entry whose
    // `ref` matches the ticket id (or title) and stores the body.
    const t = pendingTicket();
    const reply = JSON.stringify([
      { ref: String(t.id), requirements: 'The app must do X.' },
      { ref: 'unrelated', requirements: 'ignored' },
    ]);
    const ai = new FakeAiSessionPort({ outcomes: [{ kind: 'ok', result: { output: reply } }] });
    const uc = new RefineSingleTicketUseCase(ai, new FakePromptBuilderPort(), new FakeLoggerPort());

    const result = await uc.execute({ sprint: newSprint(), ticket: t, cwd: cwd() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ticket.requirements).toBe('The app must do X.');
  });

  it('falls back to the raw output when the AI did not produce JSON', async () => {
    // Soft-fail: if Claude wrote markdown without an array wrapper, the
    // parser still produces a usable ticket so the user is never stranded.
    // The text is stored verbatim as the requirements body.
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: 'The app must do X.' } }],
    });
    const uc = new RefineSingleTicketUseCase(ai, new FakePromptBuilderPort(), new FakeLoggerPort());

    const result = await uc.execute({ sprint: newSprint(), ticket: pendingTicket(), cwd: cwd() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ticket.requirements).toBe('The app must do X.');
  });

  it('empty AI output is a typed StorageError — match v0.5.0 schema-validated behaviour', async () => {
    // 0.5.0 used a schema-validated parser that rejected empty output.
    // The new parser keeps that contract: empty file / empty stdout is a
    // hard error so the user knows to re-run.
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: '' } }],
    });
    const uc = new RefineSingleTicketUseCase(ai, new FakePromptBuilderPort(), new FakeLoggerPort());

    const result = await uc.execute({ sprint: newSprint(), ticket: pendingTicket(), cwd: cwd() });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(StorageError);
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

  it('logs the ticket id and a title slice in the refining-ticket message', async () => {
    // The execute view's log tail only renders `message`, so ticket-level
    // specificity has to live in the message string — not just context.
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: 'reqs' } }],
    });
    const logger = new FakeLoggerPort();
    const uc = new RefineSingleTicketUseCase(ai, new FakePromptBuilderPort(), logger);

    const ticket = pendingTicket();
    await uc.execute({ sprint: newSprint(), ticket, cwd: cwd() });

    const refining = logger.entries.find((e) => e.message.startsWith('refining ticket'));
    expect(refining).toBeDefined();
    expect(refining?.message).toContain(String(ticket.id));
    expect(refining?.message).toContain('Initial title');
  });

  it('emits a success-level log when the ticket is approved', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: 'reqs' } }],
    });
    const logger = new FakeLoggerPort();
    const uc = new RefineSingleTicketUseCase(ai, new FakePromptBuilderPort(), logger);

    const ticket = pendingTicket();
    const result = await uc.execute({ sprint: newSprint(), ticket, cwd: cwd() });
    expect(result.ok).toBe(true);

    const successEntry = logger.entries.find((e) => e.level === 'success' && e.message.startsWith('refined ticket'));
    expect(successEntry).toBeDefined();
    expect(successEntry?.message).toContain(String(ticket.id));
  });

  it('does NOT emit a success log when the reviewer rejects the proposal', async () => {
    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: 'reqs' } }],
    });
    const logger = new FakeLoggerPort();
    const uc = new RefineSingleTicketUseCase(ai, new FakePromptBuilderPort(), logger);

    const result = await uc.execute({
      sprint: newSprint(),
      ticket: pendingTicket(),
      cwd: cwd(),
      reviewBeforeApprove: () => Promise.resolve(false),
    });
    expect(result.ok).toBe(true);

    expect(logger.entries.some((e) => e.level === 'success')).toBe(false);
  });

  it('truncates very long ticket titles in the refining-ticket message', async () => {
    // 50 chars is the cap — anything longer gets a single-character ellipsis
    // appended so the log tail stays readable next to a wall of running tasks.
    const tid = TicketId.parse('cccccccc');
    if (!tid.ok) throw new Error('precondition failed');
    const longTitle = 'a'.repeat(80);
    const long = Ticket.create({ id: tid.value, title: longTitle });
    if (!long.ok) throw new Error('precondition failed');

    const ai = new FakeAiSessionPort({
      outcomes: [{ kind: 'ok', result: { output: 'reqs' } }],
    });
    const logger = new FakeLoggerPort();
    const uc = new RefineSingleTicketUseCase(ai, new FakePromptBuilderPort(), logger);

    await uc.execute({ sprint: newSprint(), ticket: long.value, cwd: cwd() });

    const refining = logger.entries.find((e) => e.message.startsWith('refining ticket'));
    expect(refining).toBeDefined();
    expect(refining?.message).toContain(String(long.value.id));
    // 50 a's + ellipsis, NOT the full 80
    expect(refining?.message).toContain(`${'a'.repeat(50)}…`);
    expect(refining?.message).not.toContain('a'.repeat(51));
  });
});
