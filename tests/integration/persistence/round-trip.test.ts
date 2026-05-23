import { describe, expect, it } from 'vitest';
import { fromJsonAttempt } from '@src/integration/persistence/task/attempt.schema.ts';
import { fromJsonTask } from '@src/integration/persistence/task/task.schema.ts';
import { fromJsonProject } from '@src/integration/persistence/project/project.schema.ts';
import { fromJsonSprint } from '@src/integration/persistence/sprint/sprint.schema.ts';
import { fromJsonTicket } from '@src/integration/persistence/sprint/ticket.schema.ts';
import { fromJsonSprintExecution } from '@src/integration/persistence/sprint-execution/sprint-execution.schema.ts';
import { startAttempt, recordAttemptVerification, completeAttempt } from '@src/domain/entity/attempt.ts';
import {
  FIXED_NOW,
  isoTimestamp,
  makeApprovedTicket,
  makeDoneTask,
  makeDraftSprintBundle,
  makeInProgressTaskWithRunningAttempt,
  makePendingTicket,
  FIXED_REPOSITORY_ID,
  makeProject,
  makeTodoTask,
} from '@tests/fixtures/domain.ts';
import { appendExecutionSetupRun, recordExecutionPullRequestUrl } from '@src/domain/entity/sprint-execution.ts';

const roundTrip = <T>(
  value: T,
  fromJson: (
    input: unknown
  ) => { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }
): T => {
  const json = JSON.parse(JSON.stringify(value)) as unknown;
  const r = fromJson(json);
  if (!r.ok) throw new Error(`fromJson failed: ${JSON.stringify(r.error, null, 2)}`);
  return r.value;
};

describe('codec round-trip', () => {
  it('Project — preserves identity, repositories, optional description', () => {
    const original = makeProject();
    expect(roundTrip(original, fromJsonProject)).toEqual(original);
  });

  it('Ticket pending — survives missing requirements key', () => {
    const original = makePendingTicket();
    expect(roundTrip(original, fromJsonTicket)).toEqual(original);
  });

  it('Ticket approved — preserves requirements text', () => {
    const original = makeApprovedTicket();
    expect(roundTrip(original, fromJsonTicket)).toEqual(original);
  });

  it('Ticket with externalRef — preserves the verbatim tracker reference', () => {
    const original = makeApprovedTicket({ externalRef: '#123' });
    expect(roundTrip(original, fromJsonTicket)).toEqual(original);
  });

  it('Ticket without externalRef — back-compat: absent JSON key parses to undefined', () => {
    const raw = JSON.parse(JSON.stringify(makeApprovedTicket())) as { externalRef?: unknown };
    expect(raw.externalRef).toBeUndefined();
    const r = fromJsonTicket(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.externalRef).toBeUndefined();
  });

  it('Sprint draft — preserves projectName and tickets', () => {
    const bundle = makeDraftSprintBundle();
    const sprint = { ...bundle.sprint, tickets: [makeApprovedTicket()] };
    expect(roundTrip(sprint, fromJsonSprint)).toEqual(sprint);
  });

  it('SprintExecution — non-empty setupRanAt round-trips (regression: was a Map)', () => {
    const bundle = makeDraftSprintBundle();
    const withRun = appendExecutionSetupRun(bundle.execution, {
      repositoryId: FIXED_REPOSITORY_ID,
      ranAt: isoTimestamp('2026-01-01T00:00:00Z'),
      command: 'pnpm install',
      exitCode: 0,
      durationMs: 1500,
      outcome: 'success',
    });
    const withPr = (() => {
      const r = recordExecutionPullRequestUrl(withRun, 'https://example.com/pr/1');
      if (!r.ok) throw new Error('seed');
      return r.value;
    })();
    expect(roundTrip(withPr, fromJsonSprintExecution)).toEqual(withPr);
  });

  it('Task todo — round-trips with empty attempts', () => {
    const original = makeTodoTask();
    expect(roundTrip(original, fromJsonTask)).toEqual(original);
  });

  it('Task with externalRefs — preserves the verbatim list', () => {
    const original = makeTodoTask({ externalRefs: ['#123', '!456'] });
    expect(roundTrip(original, fromJsonTask)).toEqual(original);
  });

  it('Task without externalRefs — back-compat: absent JSON key parses to undefined', () => {
    const raw = JSON.parse(JSON.stringify(makeTodoTask())) as { externalRefs?: unknown };
    expect(raw.externalRefs).toBeUndefined();
    const r = fromJsonTask(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.externalRefs).toBeUndefined();
  });

  it('Task in_progress — preserves running attempt', () => {
    const original = makeInProgressTaskWithRunningAttempt();
    expect(roundTrip(original, fromJsonTask)).toEqual(original);
  });

  it('Task done — preserves verified attempt and finalAttemptN', () => {
    const original = makeDoneTask();
    const back = roundTrip(original, fromJsonTask);
    expect(back).toEqual(original);
  });

  it('Attempt running — round-trips on its own', () => {
    const r = startAttempt({ n: 1, startedAt: FIXED_NOW, sessionId: 'sess' });
    if (!r.ok) throw new Error('seed');
    expect(roundTrip(r.value, fromJsonAttempt)).toEqual(r.value);
  });

  it('Attempt verified — round-trips with verification structurally guaranteed', () => {
    const r = startAttempt({ n: 1, startedAt: FIXED_NOW });
    if (!r.ok) throw new Error('seed');
    const withVerification = recordAttemptVerification(r.value);
    const finished = completeAttempt(withVerification, 'verified', FIXED_NOW);
    if (!finished.ok) throw new Error('seed');
    expect(roundTrip(finished.value, fromJsonAttempt)).toEqual(finished.value);
  });

  it('rejects malformed input with ParseError', () => {
    const r = fromJsonProject({ wrong: 'shape' });
    expect(r.ok).toBe(false);
  });
});
