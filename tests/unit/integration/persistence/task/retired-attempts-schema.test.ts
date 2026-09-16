/**
 * `retiredAttempts` is the archive that makes `unblockTask` non-destructive: the attempts,
 * per-criterion verdicts and escalation stamps a clean restart clears off the live task are kept
 * there instead of deleted. It crosses the codec as a nested object, and `toJsonTask` is a bare
 * pass-through while zod strips undeclared keys on read — so a field dropped from `RetiredRunSchema`
 * (or from the blocked variant's triage fields) would silently delete history on the next `saveAll`
 * with typecheck, lint and the rest of the suite still green.
 *
 * These are the authoritative round-trip checks the `Compatible<…, RetiredRun>` tripwire in
 * `task.schema.ts` defers to, following the convention set by `block-kind-schema.test.ts` /
 * `criteria-verdicts-schema.test.ts`: one codec test per newly-persisted field.
 */

import { describe, expect, it } from 'vitest';
import type { Result } from '@src/domain/result.ts';
import type { BlockedTask, Task } from '@src/domain/entity/task.ts';
import { startNextAttempt } from '@src/domain/entity/task-attempts.ts';
import { applyCriteriaVerdicts } from '@src/domain/entity/task-criteria.ts';
import { markTaskBlocked, unblockTask } from '@src/domain/entity/task-lifecycle.ts';
import {
  failCurrentAttempt,
  recordTaskBestOfNGrant,
  recordTaskEffortEscalation,
  recordTaskEscalation,
  recordTaskEvaluatorEffortEscalation,
} from '@src/domain/entity/task-settle.ts';
import { fromJsonTask, toJsonTask } from '@src/integration/persistence/task/task.schema.ts';
import { FIXED_LATER, FIXED_NOW, makeTodoTask } from '@tests/fixtures/domain.ts';

const unwrap = <T, E>(result: Result<T, E>): T => {
  if (!result.ok) throw new Error(`fixture unwrap failed: ${JSON.stringify(result.error)}`);
  return result.value as T;
};

/**
 * A blocked task that has already been through one block → unblock cycle, so it carries a fully
 * populated `retiredAttempts[0]` (attempts + criteriaVerdicts + all four escalation stamps), the
 * permanent best-of-N marker, and the generator's structured triage on the CURRENT block.
 */
const blockedTaskWithArchive = (): BlockedTask => {
  const started = unwrap(startNextAttempt(makeTodoTask({ name: 'archived' }), FIXED_NOW, 'session-1'));
  const bumped = unwrap(recordTaskEscalation(started, 'claude-sonnet-4-6', 'claude-opus-4-8'));
  const effort = unwrap(recordTaskEffortEscalation(bumped, 'high'));
  const evaluatorEffort = unwrap(recordTaskEvaluatorEffortEscalation(effort, 'high'));
  const granted = unwrap(recordTaskBestOfNGrant(evaluatorEffort, 3));
  const failed = unwrap(failCurrentAttempt(granted, FIXED_LATER, 'failed'));
  const firstBlock = applyCriteriaVerdicts(unwrap(markTaskBlocked(failed, 'attempt budget exhausted', 'own')), [
    { id: 'C1', passed: false },
  ]);

  // The unblock retires everything above; the second cycle then blocks again with triage attached.
  const revived = unwrap(unblockTask(firstBlock));
  const retried = unwrap(startNextAttempt(revived, FIXED_NOW, 'session-2'));
  const retryFailed = unwrap(failCurrentAttempt(retried, FIXED_LATER, 'failed'));
  const secondBlock = unwrap(markTaskBlocked(retryFailed, 'still missing the target database', 'own'));
  return {
    ...secondBlock,
    blockerClass: 'missing-information',
    question: 'Which database should this task connect to?',
    whatUnblocksMe: 'Confirm the target database name.',
  };
};

describe('task.schema — retiredAttempts + blocked-triage round-trip', () => {
  it('round-trips a populated archive element-for-element', () => {
    const original = blockedTaskWithArchive();
    // Guard the fixture itself: a change upstream that stopped archiving would otherwise make the
    // assertions below pass vacuously against an empty archive.
    expect(original.retiredAttempts).toHaveLength(1);

    const parsed = fromJsonTask(toJsonTask(original));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const run = parsed.value.retiredAttempts?.[0];
    expect(run).toEqual(original.retiredAttempts?.[0]);
    expect(run?.attempts).toHaveLength(1);
    expect(run?.criteriaVerdicts).toEqual({ C1: 'failed' });
    expect(run?.escalatedFromModel).toBe('claude-sonnet-4-6');
    expect(run?.escalatedToModel).toBe('claude-opus-4-8');
    expect(run?.escalatedToEffort).toBe('high');
    expect(run?.escalatedToEvaluatorEffort).toBe('high');
  });

  it('round-trips the generator triage fields on the live block', () => {
    const original = blockedTaskWithArchive();

    const parsed = fromJsonTask(toJsonTask(original));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.value.status !== 'blocked') throw new Error('expected a blocked task back');

    expect(parsed.value.blockerClass).toBe('missing-information');
    expect(parsed.value.question).toBe('Which database should this task connect to?');
    expect(parsed.value.whatUnblocksMe).toBe('Confirm the target database name.');
    expect(parsed.value.blockedReason).toBe(original.blockedReason);
    // The permanent once-per-task marker rides across the unblock and must survive the codec too.
    expect(parsed.value.bestOfNGranted).toBe(true);
  });

  it('round-trips the whole entity unchanged — no field is dropped or invented', () => {
    const original = blockedTaskWithArchive();

    const parsed = fromJsonTask(toJsonTask(original));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual(original);
  });

  it('still parses a legacy row that carries none of the new fields', () => {
    // Every `tasks.json` written before the archive and the triage existed. Stripping the keys is
    // exactly what such a file looks like on disk — the read must heal them to `undefined`, never
    // fail the whole file.
    const original = blockedTaskWithArchive();
    const {
      retiredAttempts: _archive,
      blockerClass: _blockerClass,
      question: _question,
      whatUnblocksMe: _unblocks,
      bestOfNGranted: _bestOfN,
      ...legacy
    } = toJsonTask(original) as Record<string, unknown> & Task;
    void _archive;
    void _blockerClass;
    void _question;
    void _unblocks;
    void _bestOfN;

    const parsed = fromJsonTask(legacy);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.value.status !== 'blocked') throw new Error('expected a blocked task back');
    expect(parsed.value.retiredAttempts).toBeUndefined();
    expect(parsed.value.blockerClass).toBeUndefined();
    expect(parsed.value.question).toBeUndefined();
    expect(parsed.value.whatUnblocksMe).toBeUndefined();
    // ...and the rest of the row is untouched, so a legacy file loses nothing on the way in.
    expect(parsed.value.name).toBe(original.name);
    expect(parsed.value.attempts).toHaveLength(original.attempts.length);
  });
});
