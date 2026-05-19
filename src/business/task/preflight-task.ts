import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

/**
 * Preflight check before each task: working tree must be clean. Three policies cover the three
 * caller shapes:
 *
 * - `'cancel'` (default) — reject a dirty tree with `InvalidStateError`. Safe default for
 *   non-interactive callers (CI, headless harness, tests) so the chain hard-fails instead of
 *   silently amending or overwriting a pending diff.
 * - `'continue'` — operator override: log a warning and proceed on whatever's in the tree.
 *   Used when the operator has manually inspected the tree and wants the AI to build on it.
 * - `'prompt'` — interactive recovery: invoke `askDirtyTreeChoice` to learn the user's
 *   preference (keep / stash / reset / cancel). The flow wires the integration-level prompt
 *   port into `askDirtyTreeChoice` and provides `gitStash` / `gitReset` so the user-chosen
 *   action can actually be carried out. Selecting "cancel" returns `AbortError`, treated by
 *   the chain runner as user-initiated cancellation.
 *
 * The `gitStatusEntryCount` dep returns the number of porcelain entries — caller (chain leaf)
 * adapts the underlying git runner.
 */
export type DirtyTreePolicy = 'cancel' | 'continue' | 'prompt';

/**
 * The four resolutions a user can pick when preflight finds a dirty tree under
 * `dirtyTreePolicy='prompt'`. Lifted to the business layer (rather than letting the leaf
 * map a `Choice<T>` directly) so the business module stays decoupled from the `interactive/`
 * sibling under `src/business/` (ESLint sibling-isolation rule).
 */
export type DirtyTreeChoice = 'keep' | 'stash' | 'reset' | 'cancel';

export interface PreflightTaskProps {
  readonly cwd: AbsolutePath;
  readonly gitStatusEntryCount: (cwd: AbsolutePath) => Promise<Result<number, StorageError>>;
  readonly dirtyTreePolicy?: DirtyTreePolicy;
  readonly logger: Logger;
  /**
   * Required when `dirtyTreePolicy === 'prompt'`. Returns the user's pick or an `AbortError`
   * if the user cancelled the menu itself (e.g. Ctrl-C). Function-shape so the use case
   * stays decoupled from the integration-level `InteractivePrompt` port (which lives under
   * a sibling business module).
   */
  readonly askDirtyTreeChoice?: (input: {
    readonly cwd: AbsolutePath;
    readonly dirtyEntries: number;
  }) => Promise<Result<DirtyTreeChoice, AbortError>>;
  /**
   * Required when `dirtyTreePolicy === 'prompt'` and the user picks 'stash'. Receives the cwd
   * and a generated stash message; returns `{ stashed }` or a StorageError. Function-shape so
   * the use case stays integration-agnostic.
   */
  readonly gitStash?: (
    cwd: AbsolutePath,
    message: string
  ) => Promise<Result<{ readonly stashed: boolean }, StorageError>>;
  /**
   * Required when `dirtyTreePolicy === 'prompt'` and the user picks 'reset'. Wipes uncommitted
   * + untracked changes. Function-shape so the use case stays integration-agnostic.
   */
  readonly gitReset?: (cwd: AbsolutePath) => Promise<Result<void, StorageError>>;
  /** Required when `dirtyTreePolicy === 'prompt'`. Used to stamp the stash message timestamp. */
  readonly clock?: () => IsoTimestamp;
  /** Optional sprint id surfaced in the stash message so the user can locate it later. */
  readonly sprintId?: string;
}

export type PreflightTaskOutput = void;

const ELEMENT_NAME = 'preflight-task';

export const preflightTaskUseCase = async (
  props: PreflightTaskProps
): Promise<Result<PreflightTaskOutput, AbortError | InvalidStateError | StorageError>> => {
  const log = props.logger.named('task.preflight');
  log.debug('checking working tree', { cwd: props.cwd });

  const count = await props.gitStatusEntryCount(props.cwd);
  if (!count.ok) {
    log.error('git status failed', { cwd: props.cwd, error: count.error.message });
    return Result.error(count.error);
  }
  if (count.value === 0) {
    log.debug('working tree clean', { cwd: props.cwd });
    return Result.ok(undefined);
  }

  const policy: DirtyTreePolicy = props.dirtyTreePolicy ?? 'cancel';

  if (policy === 'continue') {
    log.warn(`working tree dirty (${String(count.value)} entries) — proceeding (policy=continue)`, {
      cwd: props.cwd,
      dirtyEntries: count.value,
    });
    return Result.ok(undefined);
  }

  if (policy === 'prompt') {
    return resolveViaPrompt(props, count.value);
  }

  log.warn('refusing to start a task on a dirty tree', { cwd: props.cwd, dirtyEntries: count.value });
  return Result.error(
    new InvalidStateError({
      entity: 'working-tree',
      currentState: 'dirty',
      attemptedAction: 'preflight-task',
      message: `cannot start a task: ${String(count.value)} uncommitted change(s) in ${String(props.cwd)}`,
      hint: 'commit or stash your work, or pass --dirty=continue to override',
    })
  );
};

const resolveViaPrompt = async (
  props: PreflightTaskProps,
  dirtyEntries: number
): Promise<Result<PreflightTaskOutput, AbortError | InvalidStateError | StorageError>> => {
  const log = props.logger.named('task.preflight');

  // The flow always wires askDirtyTreeChoice / gitStash / gitReset / clock when it sets
  // policy='prompt'. A missing dep here means the composition root forgot to plumb something —
  // a wiring bug, not a runtime condition the user can recover from. Throw an InvalidStateError
  // so the harness surfaces a clear error rather than silently degrading.
  if (
    props.askDirtyTreeChoice === undefined ||
    props.gitStash === undefined ||
    props.gitReset === undefined ||
    props.clock === undefined
  ) {
    throw new InvalidStateError({
      entity: ELEMENT_NAME,
      currentState: 'prompt-without-deps',
      attemptedAction: 'configure-prompt-deps',
      message:
        "preflight-task: dirtyTreePolicy='prompt' requires askDirtyTreeChoice, gitStash, gitReset, and clock dependencies",
    });
  }

  const choice = await props.askDirtyTreeChoice({ cwd: props.cwd, dirtyEntries });
  if (!choice.ok) {
    // askDirtyTreeChoice already returns AbortError on user cancellation; propagate verbatim
    // so the chain treats it as user-initiated cancellation.
    return Result.error(choice.error);
  }

  switch (choice.value) {
    case 'keep':
      log.info(`working tree dirty (${String(dirtyEntries)} entries) — proceeding (user chose 'keep')`, {
        cwd: props.cwd,
        dirtyEntries,
      });
      return Result.ok(undefined);

    case 'stash': {
      const sprintLabel = props.sprintId !== undefined && props.sprintId.length > 0 ? props.sprintId : 'unknown';
      const message = `ralphctl preflight stash (sprint ${sprintLabel}, ${String(props.clock())})`;
      const stashed = await props.gitStash(props.cwd, message);
      if (!stashed.ok) return Result.error(stashed.error);
      if (!stashed.value.stashed) {
        // Defensive: we just observed the tree is dirty, so gitStash should have stashed. If it
        // reports nothing-to-stash anyway (race against an external process), don't block —
        // the tree is now clean enough to proceed.
        log.warn('stash reported no changes despite dirty status — proceeding', { cwd: props.cwd });
        return Result.ok(undefined);
      }
      log.info(`stashed working tree — recoverable as: ${message}`, { cwd: props.cwd, stashMessage: message });
      return Result.ok(undefined);
    }

    case 'reset': {
      const reset = await props.gitReset(props.cwd);
      if (!reset.ok) return Result.error(reset.error);
      log.info('reset working tree — discarded uncommitted + untracked changes', { cwd: props.cwd });
      return Result.ok(undefined);
    }

    case 'cancel':
      return Result.error(
        new AbortError({ elementName: ELEMENT_NAME, reason: 'user cancelled on dirty working tree' })
      );
  }
};
