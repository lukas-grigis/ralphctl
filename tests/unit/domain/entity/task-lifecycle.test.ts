import { describe, expect, it } from 'vitest';
import {
  BLOCKED_UPSTREAM_REASON_PREFIX,
  classifyBlock,
  defaultFaultSideFor,
  faultSideForAbortCause,
  inferBlockCause,
  isUpstreamBlocked,
  markTaskBlocked,
  unblockTask,
} from '@src/domain/entity/task-lifecycle.ts';
import {
  recordTaskBestOfNGrant,
  recordTaskEffortEscalation,
  recordTaskEscalation,
  recordTaskEvaluatorEffortEscalation,
} from '@src/domain/entity/task-settle.ts';
import { applyCriteriaVerdicts } from '@src/domain/entity/task-criteria.ts';
import { startNextAttempt } from '@src/domain/entity/task-attempts.ts';
import type { BlockedTask } from '@src/domain/entity/task.ts';
import { FIXED_NOW, makeInProgressTaskWithRunningAttempt, makeTodoTask } from '@tests/fixtures/domain.ts';

const block = (reason: string, kind: BlockedTask['blockKind']): BlockedTask => {
  const r = markTaskBlocked(makeTodoTask(), reason, kind);
  if (!r.ok) throw new Error(`expected blocked ok: ${r.error.message}`);
  return r.value;
};

describe('markTaskBlocked — blockKind discriminant', () => {
  it('stamps the supplied blockKind onto the blocked task', () => {
    expect(block('prerequisite not done', 'upstream').blockKind).toBe('upstream');
    expect(block('verify failed', 'own').blockKind).toBe('own');
  });

  it('rejects re-blocking a non-runnable task regardless of blockKind', () => {
    const blocked = block('first block', 'own');
    const again = markTaskBlocked(blocked, 'second block', 'upstream');
    expect(again.ok).toBe(false);
  });
});

describe('isUpstreamBlocked — reads the structural discriminant, NOT the reason text', () => {
  it('is true when blockKind is upstream', () => {
    expect(isUpstreamBlocked(block(`${BLOCKED_UPSTREAM_REASON_PREFIX} — prerequisite not done`, 'upstream'))).toBe(
      true
    );
  });

  it('is false when blockKind is own', () => {
    expect(isUpstreamBlocked(block('verify failed on its own merits', 'own'))).toBe(false);
  });

  it('a self-block reason that LITERALLY starts with "blocked upstream" but is kind=own is NOT upstream', () => {
    // The fragile prefix heuristic this replaces would have mis-classified this own-failure block as
    // auto-clearable. The structural discriminant is the only source of truth.
    const masquerading = block(`${BLOCKED_UPSTREAM_REASON_PREFIX} but actually our own bug`, 'own');
    expect(masquerading.blockedReason.startsWith(BLOCKED_UPSTREAM_REASON_PREFIX)).toBe(true);
    expect(isUpstreamBlocked(masquerading)).toBe(false);
  });

  it('a todo/in_progress task is never upstream-blocked', () => {
    expect(isUpstreamBlocked(makeTodoTask())).toBe(false);
  });
});

describe('unblockTask — clean restart (drops block fields, resets budget + escalation)', () => {
  it('strips the blocked-only fields when resetting to todo', () => {
    const back = unblockTask(block(`${BLOCKED_UPSTREAM_REASON_PREFIX} — dep`, 'upstream'));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.status).toBe('todo');
    expect((back.value as unknown as Record<string, unknown>)['blockKind']).toBeUndefined();
    expect((back.value as unknown as Record<string, unknown>)['blockedReason']).toBeUndefined();
    expect((back.value as unknown as Record<string, unknown>)['blockCause']).toBeUndefined();
    expect((back.value as unknown as Record<string, unknown>)['faultSide']).toBeUndefined();
  });

  it("strips the generator's structured blocker triage too, so it never leaks onto the restarted todo task", () => {
    // Regression: `blockerClass` / `question` / `whatUnblocksMe` are new fields on `BlockedTask`
    // (the generator's own triage for a `task-blocked` signal) that must be dropped on unblock the
    // SAME way `blockCause` / `faultSide` already are — otherwise a stale answer from the PRIOR
    // block cycle would ride onto the fresh `todo` task's shape.
    const blocked = block('Scope unclear.', 'own');
    const withTriage: BlockedTask = {
      ...blocked,
      blockerClass: 'ambiguous-request',
      question: 'Should this cover the admin routes too?',
      whatUnblocksMe: 'A decision on admin-route scope',
    };
    const back = unblockTask(withTriage);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.status).toBe('todo');
    expect((back.value as unknown as Record<string, unknown>)['blockerClass']).toBeUndefined();
    expect((back.value as unknown as Record<string, unknown>)['question']).toBeUndefined();
    expect((back.value as unknown as Record<string, unknown>)['whatUnblocksMe']).toBeUndefined();
  });

  it('resets the attempt budget and clears model escalation so the retry gets a genuine fresh run', () => {
    // Build an own-blocked task that carries a full attempt history AND a climbed-to escalation
    // model — the exact shape that, without the reset, would hit `budget-exhausted` / `topped-out`
    // on its very first retry plateau.
    const inProgress = makeInProgressTaskWithRunningAttempt({ maxAttempts: 3 });
    const escalated = recordTaskEscalation(inProgress, 'claude-sonnet-4-6', 'claude-opus-4-8');
    if (!escalated.ok) throw escalated.error;
    // Also carry a raised effort — the effort rung's per-run remedy must reset too.
    const effortEscalated = recordTaskEffortEscalation(escalated.value, 'high');
    if (!effortEscalated.ok) throw effortEscalated.error;
    // And the evaluator's own lockstep effort bump — same clean-restart rationale.
    const evaluatorEffortEscalated = recordTaskEvaluatorEffortEscalation(effortEscalated.value, 'high');
    if (!evaluatorEffortEscalated.ok) throw evaluatorEffortEscalated.error;
    const blocked = markTaskBlocked(evaluatorEffortEscalated.value, 'attempt budget exhausted', 'own');
    if (!blocked.ok) throw blocked.error;
    expect(blocked.value.attempts.length).toBeGreaterThan(0);

    const back = unblockTask(blocked.value);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.status).toBe('todo');
    expect(back.value.attempts).toHaveLength(0); // fresh budget
    expect((back.value as unknown as Record<string, unknown>)['escalatedFromModel']).toBeUndefined();
    expect((back.value as unknown as Record<string, unknown>)['escalatedToModel']).toBeUndefined();
    expect((back.value as unknown as Record<string, unknown>)['escalatedToEffort']).toBeUndefined();
    expect((back.value as unknown as Record<string, unknown>)['escalatedToEvaluatorEffort']).toBeUndefined();
    // The cap itself (a planning field) survives — only the consumed budget resets.
    expect(back.value.maxAttempts).toBe(3);
  });

  it('drops the unconsumed best-of-N handshake but KEEPS the permanent grant marker', () => {
    // Arrange: a task whose best-of-N grant was stamped but never consumed (the attempt aborted /
    // self-blocked before `best-of-n-selection` cleared the handshake), then blocked.
    const inProgress = makeInProgressTaskWithRunningAttempt();
    const granted = recordTaskBestOfNGrant(inProgress, 3);
    if (!granted.ok) throw granted.error;
    const blocked = markTaskBlocked(granted.value, 'cancelled by operator', 'own');
    if (!blocked.ok) throw blocked.error;
    expect(blocked.value.bestOfNGrantedCandidates).toBe(3); // precondition: handshake survives the block

    // Act
    const back = unblockTask(blocked.value);

    // Assert: the transient handshake is meant to be consumed by the attempt it was issued for, so a
    // clean restart with zero attempts must not re-enter the best-of-N composite and burn N sessions.
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.attempts).toHaveLength(0);
    expect((back.value as unknown as Record<string, unknown>)['bestOfNGrantedCandidates']).toBeUndefined();
    // The PERMANENT marker survives — it is the once-per-task gate `decideEscalation` reads; clearing
    // it would let repeated block/unblock cycles re-grant N candidate sessions without bound.
    expect(back.value.bestOfNGranted).toBe(true);
  });

  it('drops criteriaVerdicts so stale k-of-N verdicts do not mislead the next run', () => {
    // Arrange: build an in-progress task that carries a graded verdict map.
    const inProgress = makeInProgressTaskWithRunningAttempt();
    const withVerdicts = applyCriteriaVerdicts(inProgress, [{ id: 'C1', passed: true }]);
    expect(withVerdicts.criteriaVerdicts).toBeDefined(); // precondition: verdicts are set

    const blocked = markTaskBlocked(withVerdicts, 'eval failed', 'own');
    if (!blocked.ok) throw blocked.error;
    expect(blocked.value.criteriaVerdicts).toBeDefined(); // precondition: verdicts survive onto blocked task

    // Act
    const back = unblockTask(blocked.value);

    // Assert: clean restart must shed the stale verdict map.
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect((back.value as unknown as Record<string, unknown>)['criteriaVerdicts']).toBeUndefined();
  });
});

describe('unblockTask — archives retired state instead of deleting it', () => {
  it('appends the cleared attempts + verdicts + escalation stamps to retiredAttempts', () => {
    const inProgress = makeInProgressTaskWithRunningAttempt();
    const escalated = recordTaskEscalation(inProgress, 'claude-sonnet-4-6', 'claude-opus-4-8');
    if (!escalated.ok) throw escalated.error;
    const withVerdicts = applyCriteriaVerdicts(escalated.value, [{ id: 'C1', passed: false }]);
    const blocked = markTaskBlocked(withVerdicts, 'attempt budget exhausted', 'own');
    if (!blocked.ok) throw blocked.error;
    const clearedAttempts = blocked.value.attempts;
    expect(clearedAttempts.length).toBeGreaterThan(0); // precondition: there is something to archive

    const back = unblockTask(blocked.value);
    expect(back.ok).toBe(true);
    if (!back.ok) return;

    // The live ledger is empty — the fresh run starts clean.
    expect(back.value.attempts).toHaveLength(0);
    // But nothing is gone: the same attempts, verdicts and escalation stamp survive in the archive.
    expect(back.value.retiredAttempts).toHaveLength(1);
    const [retired] = back.value.retiredAttempts ?? [];
    expect(retired?.attempts).toEqual(clearedAttempts);
    expect(retired?.criteriaVerdicts).toEqual({ C1: 'failed' });
    expect(retired?.escalatedFromModel).toBe('claude-sonnet-4-6');
    expect(retired?.escalatedToModel).toBe('claude-opus-4-8');
  });

  it('drops the transient best-of-N handshake from the archive too, not just the live task', () => {
    const inProgress = makeInProgressTaskWithRunningAttempt();
    const granted = recordTaskBestOfNGrant(inProgress, 3);
    if (!granted.ok) throw granted.error;
    const blocked = markTaskBlocked(granted.value, 'cancelled by operator', 'own');
    if (!blocked.ok) throw blocked.error;

    const back = unblockTask(blocked.value);
    expect(back.ok).toBe(true);
    if (!back.ok) return;

    const [retired] = back.value.retiredAttempts ?? [];
    expect(retired).toBeDefined();
    expect((retired as unknown as Record<string, unknown>)['bestOfNGrantedCandidates']).toBeUndefined();
    // The permanent marker still lives on the LIVE task, untouched by archiving.
    expect(back.value.bestOfNGranted).toBe(true);
  });

  it('accumulates one archive entry per block/unblock cycle, oldest first', () => {
    // Cycle 1: one attempt, blocked, unblocked — archives one entry.
    const blocked1 = markTaskBlocked(makeInProgressTaskWithRunningAttempt(), 'first failure', 'own');
    if (!blocked1.ok) throw blocked1.error;
    const reopened1 = unblockTask(blocked1.value);
    if (!reopened1.ok) throw reopened1.error;
    expect(reopened1.value.retiredAttempts).toHaveLength(1);

    // Cycle 2: a fresh attempt on the reopened task, blocked again — carries cycle 1's entry
    // forward untouched (markTaskBlocked never touches the archive) and adds a second attempt.
    const started = startNextAttempt(reopened1.value, FIXED_NOW, 'session-2');
    if (!started.ok) throw started.error;
    const blocked2 = markTaskBlocked(started.value, 'second failure', 'own');
    if (!blocked2.ok) throw blocked2.error;
    expect(blocked2.value.retiredAttempts).toHaveLength(1); // carried over from cycle 1

    const reopened2 = unblockTask(blocked2.value);
    expect(reopened2.ok).toBe(true);
    if (!reopened2.ok) return;
    expect(reopened2.value.retiredAttempts).toHaveLength(2);
    expect(reopened2.value.retiredAttempts?.[0]?.attempts).toHaveLength(1); // cycle 1's attempt
    expect(reopened2.value.retiredAttempts?.[1]?.attempts).toHaveLength(1); // cycle 2's own attempt
  });

  it('does not grow the archive for a cascade-reset dependent with nothing of its own to keep', () => {
    // Mirrors the upstream-cascade shape: a todo task blocked purely by the dependency gate, with
    // zero attempts, no verdicts, no escalation — archiving an empty entry would just be noise.
    const dependent = block(`${BLOCKED_UPSTREAM_REASON_PREFIX} — prerequisite not done`, 'upstream');
    expect(dependent.attempts).toHaveLength(0);

    const back = unblockTask(dependent);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.retiredAttempts).toBeUndefined();
  });
});

describe('inferBlockCause — text/blockKind-based classification', () => {
  it('classifies upstream from blockKind alone, ignoring reason text', () => {
    expect(inferBlockCause('upstream', 'anything at all')).toBe('upstream-dependency');
  });

  it('classifies each real own-failure reason text the harness is known to write', () => {
    expect(inferBlockCause('own', 'AI process repeatedly crashed; attempt budget exhausted')).toBe('budget-exhausted');
    expect(inferBlockCause('own', 'attempt budget exhausted (maxAttempts=3)')).toBe('budget-exhausted');
    expect(
      inferBlockCause('own', "fold conflict — worktree branch 'wt-abc' could not land on the sprint branch: x")
    ).toBe('fold-conflict');
    expect(
      inferBlockCause(
        'own',
        'worktree setup script failed (exit 1) — the task could not be prepared in its isolated worktree'
      )
    ).toBe('worktree-setup-failure');
    expect(
      inferBlockCause('own', 'baseline already red at task start (non-interactive — operator could not be prompted)')
    ).toBe('pre-verify-red');
    expect(inferBlockCause('own', 'operator skipped task on broken baseline')).toBe('pre-verify-red');
    expect(inferBlockCause('own', 'verify script regressed baseline (exit=1); harness will not commit on red')).toBe(
      'post-verify-regression'
    );
    expect(inferBlockCause('own', 'user cancel')).toBe('operator-cancelled');
  });

  it('falls back to the supplied ownDefault when no known pattern matches', () => {
    expect(inferBlockCause('own', 'the model gave up here')).toBe('unknown');
    expect(inferBlockCause('own', 'the model gave up here', 'generator-self-block')).toBe('generator-self-block');
  });

  it('does NOT misclassify a generator self-block whose free-form prose merely MENTIONS a crash or cancellation', () => {
    // Regression: these two reasons both mention a harness-sounding word ("crashed" / "cancel")
    // while describing something about the TASK, not about the harness or an operator action —
    // a bare `.includes` used to match them before the anchored prefix checks ran.
    expect(
      inferBlockCause(
        'own',
        'The payment sandbox crashed on every run and the cancellation policy is contradictory — I need the intended refund window.',
        'generator-self-block'
      )
    ).toBe('generator-self-block');
    expect(
      inferBlockCause('own', 'Scope is ambiguous: should this cancel in-flight orders too?', 'generator-self-block')
    ).toBe('generator-self-block');
  });

  it('classifies the exact crash producer text even with a differently-worded prefix around it', () => {
    expect(inferBlockCause('own', 'AI process repeatedly crashed; attempt budget exhausted')).toBe('budget-exhausted');
  });

  it('classifies the exact operator-cancel producer text but not a reason that only contains the substring', () => {
    expect(inferBlockCause('own', 'user cancel')).toBe('operator-cancelled');
    expect(inferBlockCause('own', 'the generator wants to cancel the retry', 'generator-self-block')).toBe(
      'generator-self-block'
    );
  });
});

describe('defaultFaultSideFor — WHO the repair belongs to, per blockCause', () => {
  it('attributes each cause to the side the ADDITIONAL DIRECTION assigns it', () => {
    expect(defaultFaultSideFor('upstream-dependency', 'x')).toBe('harness');
    expect(defaultFaultSideFor('fold-conflict', 'x')).toBe('harness');
    expect(defaultFaultSideFor('operator-cancelled', 'x')).toBe('harness');
    expect(defaultFaultSideFor('worktree-setup-failure', 'x')).toBe('environment');
    expect(defaultFaultSideFor('pre-verify-red', 'x')).toBe('environment');
    expect(defaultFaultSideFor('post-verify-regression', 'x')).toBe('model');
    expect(defaultFaultSideFor('generator-self-block', 'x')).toBe('model');
    expect(defaultFaultSideFor('unknown', 'x')).toBe('unknown');
  });

  it('a budget-exhausted cause is harness-attributed when the reason names a crash, model otherwise', () => {
    expect(defaultFaultSideFor('budget-exhausted', 'AI process repeatedly crashed; attempt budget exhausted')).toBe(
      'harness'
    );
    expect(defaultFaultSideFor('budget-exhausted', 'attempt budget exhausted (maxAttempts=3)')).toBe('model');
  });
});

describe('faultSideForAbortCause — definitive crash forensics override text guessing', () => {
  it('maps the killed/crashed causes to harness or environment', () => {
    expect(faultSideForAbortCause('watchdog-killed')).toBe('harness');
    expect(faultSideForAbortCause('sigterm')).toBe('harness');
    expect(faultSideForAbortCause('user-cancel')).toBe('harness');
    expect(faultSideForAbortCause('rate-limit-exhausted')).toBe('environment');
    expect(faultSideForAbortCause('process-crash')).toBe('environment');
  });

  it('adds no information for self-blocked / unknown — caller falls through to the text guess', () => {
    expect(faultSideForAbortCause('self-blocked')).toBeUndefined();
    expect(faultSideForAbortCause('unknown')).toBeUndefined();
  });
});

describe('classifyBlock — the single entry point every block-producing call site funnels through', () => {
  it('prefers an explicit hint over any inference', () => {
    expect(classifyBlock('irrelevant text', 'own', { blockCause: 'fold-conflict', faultSide: 'harness' })).toEqual({
      blockCause: 'fold-conflict',
      faultSide: 'harness',
    });
  });

  it('prefers abortCause-derived fault side over the text-based default', () => {
    // Plain text would default to `model` (no 'crashed' substring) — a watchdog kill overrides that.
    const result = classifyBlock('attempt budget exhausted (maxAttempts=3)', 'own', { abortCause: 'watchdog-killed' });
    expect(result).toEqual({ blockCause: 'budget-exhausted', faultSide: 'harness' });
  });

  it('falls all the way through to text-based inference when no hints are supplied', () => {
    expect(classifyBlock('user cancel', 'own')).toEqual({ blockCause: 'operator-cancelled', faultSide: 'harness' });
  });

  it('honours a narrower ownDefault for a caller with extra structural context', () => {
    expect(classifyBlock('vague generator prose', 'own', { ownDefault: 'generator-self-block' })).toEqual({
      blockCause: 'generator-self-block',
      faultSide: 'model',
    });
  });
});

describe('markTaskBlocked — stamps blockCause/faultSide (extends blockKind, never replaces it)', () => {
  it('infers upstream-dependency + harness for an upstream block with no explicit classification', () => {
    const blocked = block('blocked upstream — prerequisite not done', 'upstream');
    expect(blocked.blockCause).toBe('upstream-dependency');
    expect(blocked.faultSide).toBe('harness');
  });

  it('infers a real own-failure cause from the reason text when the caller supplies none', () => {
    const blocked = block('verify script failed (exit=1); harness will not commit on red', 'own');
    expect(blocked.blockCause).toBe('post-verify-regression');
    expect(blocked.faultSide).toBe('model');
  });

  it('accepts an explicit classification and stamps it verbatim, skipping inference entirely', () => {
    const r = markTaskBlocked(makeTodoTask(), "worktree setup script failed (exit 1) — couldn't prepare", 'own', {
      blockCause: 'worktree-setup-failure',
      faultSide: 'environment',
    });
    if (!r.ok) throw new Error(`expected blocked ok: ${r.error.message}`);
    expect(r.value.blockCause).toBe('worktree-setup-failure');
    expect(r.value.faultSide).toBe('environment');
  });

  it('falls back to unknown/unknown for an own-failure reason matching no known pattern', () => {
    const blocked = block('the generator gave a vague reason', 'own');
    expect(blocked.blockCause).toBe('unknown');
    expect(blocked.faultSide).toBe('unknown');
  });
});
