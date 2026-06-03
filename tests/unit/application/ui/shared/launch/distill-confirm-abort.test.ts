/**
 * Abort-safety of the distill confirm gate in `launchCloseSprint` and `launchReview`.
 *
 * Both launchers gate on an `askConfirm` result before creating a runner:
 *
 *   const distillConfirm = await deps.interactive.askConfirm({ message: '…' });
 *   if (!distillConfirm.ok) return { ok: false, reason: 'Cancelled.' };
 *
 * These tests pin three behaviours per launcher:
 *
 *  1. CANCEL — distill confirm returns `Result.error(AbortError)` →
 *     `{ ok: false, reason: 'Cancelled.' }`, no runner created, no sprint transition.
 *     This is the load-bearing test: removing or inverting the `if (!distillConfirm.ok)` guard
 *     makes it fail.
 *
 *  2. NO (opt-out) — distill confirm returns `Result.ok(false)` →
 *     launch proceeds with `distillRequested: false` (the in-chain guard skips the distill body).
 *
 *  3. YES (opt-in) — distill confirm returns `Result.ok(true)` →
 *     launch proceeds with `distillRequested: true`.
 *
 * For close-sprint, the FIRST confirm (the irreversible "close the sprint?" guard) must also be
 * driven to `ok(true)` so the test reaches the distill confirm. These tests only assert the
 * distill-gate path; the close/review flow execution is not started (the returned runner is not
 * run, so no chain leaves execute).
 *
 * The non-cancel cases assert `result.ok === true` (runner was created). That assertion is
 * sufficient here — the chain behaviour is covered by the e2e flow tests.
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { launchCloseSprint } from '@src/application/ui/shared/launch/close-sprint.ts';
import { launchReview } from '@src/application/ui/shared/launch/review.ts';
import type { LaunchContext } from '@src/application/ui/shared/launch/context.ts';
import type { AskConfirmInput, InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import type { Runner } from '@src/application/chain/run/runner.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import {
  makeReviewSprint,
  makeProject,
  makeRepository,
  absolutePath,
  FIXED_PROJECT_ID,
} from '@tests/fixtures/domain.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';

// ---------------------------------------------------------------------------
// Minimal fakes
// ---------------------------------------------------------------------------

/** Sprint repo that always resolves the seeded sprint (close-sprint needs findById + save). */
const inMemorySprintRepo = (initial: Sprint): SprintRepository => {
  let current = initial;
  return {
    async findById(id: SprintId) {
      if (current.id === id) return Result.ok(current);
      return Result.error(new NotFoundError({ entity: 'sprint', id: String(id) }));
    },
    async save(sprint: Sprint) {
      current = sprint;
      return Result.ok(undefined);
    },
  } as SprintRepository;
};

/**
 * Build a scripted `InteractivePrompt` whose `askConfirm` cycles through the supplied
 * response factory list in order. Each entry is a zero-arg function so the caller can
 * return different `Result` shapes per call without closure mutation.
 */
const scriptedConfirm = (responses: ReadonlyArray<() => Result<boolean, DomainError>>): InteractivePrompt => {
  let i = 0;
  return {
    async askConfirm(input: AskConfirmInput): Promise<Result<boolean, DomainError>> {
      void input;
      const fn = responses[i++];
      if (fn === undefined) throw new Error('scriptedConfirm: no more responses scripted');
      return fn();
    },
    async askText(): Promise<never> {
      throw new Error('scriptedConfirm: askText not used in distill-confirm tests');
    },
    async askTextArea(): Promise<never> {
      throw new Error('scriptedConfirm: askTextArea not used in distill-confirm tests');
    },
    async askChoice(): Promise<never> {
      throw new Error('scriptedConfirm: askChoice not used in distill-confirm tests');
    },
    async askMultiChoice(): Promise<never> {
      throw new Error('scriptedConfirm: askMultiChoice not used in distill-confirm tests');
    },
  };
};

const abort = (): Result<boolean, DomainError> =>
  Result.error(new AbortError({ elementName: 'distill-confirm-test', reason: 'user pressed Ctrl+C' }));
const yes = (): Result<boolean, DomainError> => Result.ok(true);
const no = (): Result<boolean, DomainError> => Result.ok(false);

/** Identity bridge — no event bus needed for launcher-unit tests. */
const identityBridge = <T>(runner: Runner<T>): Runner<T> => runner;

const FAKE_DATA_ROOT = absolutePath('/tmp/ralphctl-distill-confirm-test/data');
const FAKE_LOCKS_ROOT = absolutePath('/tmp/ralphctl-distill-confirm-test/state/locks');
const FAKE_MEMORY_ROOT = absolutePath('/tmp/ralphctl-distill-confirm-test/data/memory');

const STUB_STORAGE = {
  dataRoot: FAKE_DATA_ROOT,
  locksRoot: FAKE_LOCKS_ROOT,
  memoryRoot: FAKE_MEMORY_ROOT,
  appRoot: absolutePath('/tmp/ralphctl-distill-confirm-test'),
  configRoot: absolutePath('/tmp/ralphctl-distill-confirm-test/config'),
  stateRoot: absolutePath('/tmp/ralphctl-distill-confirm-test/state'),
  runsRoot: absolutePath('/tmp/ralphctl-distill-confirm-test/data/runs'),
  operatorSkillsRoot: absolutePath('/tmp/ralphctl-distill-confirm-test/skills'),
};

/** No-op append — review and close-sprint both thread this port into the flow factory. */
const noopAppendFile = async (): Promise<Result<undefined, DomainError>> => Result.ok(undefined);

/** No-op write — resolveDistillComposition threads this into the distill sub-chain deps. */
const noopWriteFile = async (): Promise<Result<undefined, DomainError>> => Result.ok(undefined);

/** No-op interactive AI — resolveDistillComposition only references it; distill never runs. */
const stubInteractiveAiFor = () =>
  ({
    run: async () => Result.ok({ content: '' }),
  }) as never;

/**
 * Minimal `AppDeps` subset that the launchers and `resolveDistillComposition` consume.
 * Only the fields the launchers actually read are populated; the rest are cast `as never`
 * because typescript can't verify the partial shape but the launchers never touch them.
 */
const stubAppDeps = (sprintRepo: SprintRepository): LaunchContext['deps']['app'] =>
  ({
    sprintRepo,
    taskRepo: {
      async findBySprintId() {
        return Result.ok([]);
      },
      async findById() {
        return Result.error(new NotFoundError({ entity: 'task', id: 'missing' }));
      },
      async update() {
        return Result.ok(undefined);
      },
      async saveAll() {
        return Result.ok(undefined);
      },
    },
    clock: () => IsoTimestamp.now(),
    logger: noopLogger,
    appendFile: noopAppendFile,
    writeFile: noopWriteFile,
    interactiveAiFor: stubInteractiveAiFor,
    templateLoader: {} as never,
    eventBus: { publish: () => {}, subscribe: () => () => {} } as never,
    signals: { emit: async () => {} } as never,
    gitRunner: {} as never,
    shellScriptRunner: {} as never,
    fileLocker: {} as never,
    provider: {} as never,
    interactiveAi: {} as never,
    settingsRepo: {} as never,
    settings: DEFAULT_SETTINGS,
    probes: {} as never,
    projectRepo: {} as never,
    sprintExecutionRepo: {} as never,
    pullRequestCreator: {} as never,
    versionChecker: {} as never,
    skillsAdapter: {} as never,
    skillSource: {} as never,
    notificationDispatcher: { notify: async () => {} } as never,
    chainLogSink: () => ({ stop: async () => {}, flush: async () => {} }) as never,
  }) as never;

/** A project with one repository — required by `resolveDistillComposition`. */
const stubProject = makeProject({ id: FIXED_PROJECT_ID, repositories: [makeRepository()] });

/**
 * Build a minimal `AppStateSnapshot` for the close-sprint and review launchers.
 * `sprint` defaults to a ReviewSprint so both launchers pass the status guard.
 *
 * `omitSprint` / `omitProject`: when true, the optional fields are omitted entirely —
 * required for `exactOptionalPropertyTypes` compatibility (spreading `{ sprint: undefined }`
 * into a partial fails under that flag because `Sprint | undefined` ≠ `Sprint`).
 */
const makeSnapshot = (
  opts: { readonly omitSprint?: boolean; readonly omitProject?: boolean } = {}
): AppStateSnapshot => {
  const sprint = makeReviewSprint();
  const base = {
    tasks: [],
    triggerInputs: {
      hasProject: true,
      currentSprintStatus: 'review' as const,
      pendingTicketCount: 0,
      approvedTicketCount: 1,
      resumableTaskCount: 0,
    },
    projectCount: 1,
    sprintCount: 1,
    recentSprints: [] as const,
  };
  return {
    ...base,
    ...(opts.omitProject ? {} : { project: stubProject }),
    ...(opts.omitSprint ? {} : { sprint }),
  } as AppStateSnapshot;
};

const buildCtx = (interactive: InteractivePrompt, snapshot: AppStateSnapshot): LaunchContext => {
  const sprint = snapshot.sprint ?? makeReviewSprint();
  const sprintRepo = inMemorySprintRepo(sprint);
  return {
    deps: {
      interactive,
      storage: STUB_STORAGE,
      app: stubAppDeps(sprintRepo),
      runInTerminal: async (fn) => fn(),
    },
    snapshot,
    extras: {},
    settings: DEFAULT_SETTINGS,
    provider: {} as never,
    interactiveAi: {} as never,
    skillsAdapter: {} as never,
    skillSource: {} as never,
    cwd: undefined,
    sessionId: () => 'r-test-session',
    bridge: identityBridge,
  };
};

// ---------------------------------------------------------------------------
// launchCloseSprint — distill confirm gate
// ---------------------------------------------------------------------------

describe('launchCloseSprint — distill confirm gate', () => {
  it('returns Cancelled when distill confirm is aborted via Ctrl+C (AbortError) — cancel path', async () => {
    // close-sprint has TWO confirms: first the irreversible close guard, then the distill prompt.
    // Drive the first to `ok(true)` so we reach the distill confirm, then abort there.
    const interactive = scriptedConfirm([yes, abort]);
    const snapshot = makeSnapshot();
    const ctx = buildCtx(interactive, snapshot);

    const result = await launchCloseSprint(ctx);

    // The load-bearing assertion: this FAILS if `if (!distillConfirm.ok) return { ok: false, … }`
    // is removed or the condition is inverted.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('Cancelled.');
  });

  it('returns ok runner when distill confirm is deliberately declined (Result.ok(false))', async () => {
    // "No" to distill → distillRequested: false → launch proceeds, runner returned, no cancel.
    const interactive = scriptedConfirm([yes, no]);
    const snapshot = makeSnapshot();
    const ctx = buildCtx(interactive, snapshot);

    const result = await launchCloseSprint(ctx);

    // No cancel — a runner is returned. We do not start it (chain execution is not the focus here).
    expect(result.ok).toBe(true);
  });

  it('returns ok runner when distill confirm is affirmatively accepted (Result.ok(true))', async () => {
    // "Yes" to distill → distillRequested: true → launch proceeds, runner returned.
    const interactive = scriptedConfirm([yes, yes]);
    const snapshot = makeSnapshot();
    const ctx = buildCtx(interactive, snapshot);

    const result = await launchCloseSprint(ctx);

    expect(result.ok).toBe(true);
  });

  it('returns Cancelled when the first close confirm is aborted (pre-distill guard)', async () => {
    // Belt-and-suspenders: the first guard also cancels on abort. If both guards are intact,
    // abort on the first confirm must also yield Cancelled.
    const interactive = scriptedConfirm([abort]);
    const snapshot = makeSnapshot();
    const ctx = buildCtx(interactive, snapshot);

    const result = await launchCloseSprint(ctx);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('Cancelled.');
  });

  it('returns Cancelled (not ok) when no sprint is selected', async () => {
    const interactive = scriptedConfirm([]);
    const snapshot = makeSnapshot({ omitSprint: true });
    const ctx = buildCtx(interactive, snapshot);

    const result = await launchCloseSprint(ctx);

    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// launchReview — distill confirm gate
// ---------------------------------------------------------------------------

describe('launchReview — distill confirm gate', () => {
  it('returns Cancelled when distill confirm is aborted via Ctrl+C (AbortError) — cancel path', async () => {
    // launchReview has ONE HITL before the chain: the distill confirm. Drive it to abort.
    const interactive = scriptedConfirm([abort]);
    const snapshot = makeSnapshot();
    const ctx = buildCtx(interactive, snapshot);

    const result = await launchReview(ctx);

    // The load-bearing assertion: this FAILS if `if (!distillConfirm.ok) return { ok: false, … }`
    // is removed or the condition is inverted.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('Cancelled.');
  });

  it('returns ok runner when distill confirm is deliberately declined (Result.ok(false))', async () => {
    // "No" to distill → distillRequested: false → launch proceeds, runner returned, no cancel.
    const interactive = scriptedConfirm([no]);
    const snapshot = makeSnapshot();
    const ctx = buildCtx(interactive, snapshot);

    const result = await launchReview(ctx);

    expect(result.ok).toBe(true);
  });

  it('returns ok runner when distill confirm is affirmatively accepted (Result.ok(true))', async () => {
    const interactive = scriptedConfirm([yes]);
    const snapshot = makeSnapshot();
    const ctx = buildCtx(interactive, snapshot);

    const result = await launchReview(ctx);

    expect(result.ok).toBe(true);
  });

  it('returns failure when no sprint is selected', async () => {
    const interactive = scriptedConfirm([]);
    const snapshot = makeSnapshot({ omitSprint: true });
    const ctx = buildCtx(interactive, snapshot);

    const result = await launchReview(ctx);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('No sprint selected');
  });

  it('returns failure when no project is loaded', async () => {
    const interactive = scriptedConfirm([]);
    const snapshot = makeSnapshot({ omitProject: true });
    const ctx = buildCtx(interactive, snapshot);

    const result = await launchReview(ctx);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('No project loaded');
  });
});
