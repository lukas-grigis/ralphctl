import type { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { VerifyRun, VerifyRunPhase } from '@src/domain/entity/attempt.ts';
import type { VerifyGate } from '@src/domain/entity/repository.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

/** {@link VerifyRun} outcome for a verify command the shell could not start. */
const SPAWN_ERROR_OUTCOME = 'spawn-error';

/** Spawn port the verify executor runs each gate command through. */
export type RunShellScript = (
  cwd: AbsolutePath,
  script: string,
  opts: { readonly timeoutMs?: number; readonly env?: Readonly<Record<string, string>> }
) => Promise<
  Result<
    {
      readonly passed: boolean;
      readonly exitCode: number | null;
      readonly output: string;
      readonly durationMs: number;
      /** Runner killed it (timeout / output cap); never confirm-re-run — a hang is no flake. Absent = false. */
      readonly timedOut?: boolean;
    },
    StorageError
  >
>;

/**
 * Use-case output.
 *
 *  - `run` — the persisted-shape audit row (no stdout body).
 *  - `rawOutput` — the full untruncated stdout+stderr from the spawn. Empty string for
 *    `skipped` / `spawn-error` outcomes. The leaf persists this to
 *    `<sprintDir>/logs/verify/<task-id>/{pre,post}-attempt-<N>.log` per audit-[01].
 *  - `spawnErrorMessage` — present only for `outcome: 'spawn-error'`; carries the shell
 *    runner's error message so the leaf can surface an actionable log line and a short
 *    excerpt onto `lastVerifyResult.stderr`.
 */
export interface RunVerifyScriptOutput {
  readonly run: VerifyRun;
  readonly rawOutput: string;
  readonly spawnErrorMessage?: string;
}

// ───────────────────────────── multi-gate verify (WS3 / T10) ─────────────────────────────

/**
 * How a multi-gate run treats a gate that exits non-zero.
 *
 *  - `'fail-fast'` — stop at the first failing gate. Post-verify uses this: the attempt's diff
 *    footprint scopes which gates run, and one red gate is enough to reject the work.
 *  - `'all-run'`   — execute every (filtered) gate regardless of intermediate failures. Pre-verify
 *    uses this: the baseline snapshot needs the COMPLETE picture so attribution compares
 *    like-vs-like per gate (a post that re-runs a subset still ran in the pre's superset).
 *
 * Caller-chosen, never a hidden heuristic.
 */
export type VerifyGateMode = 'fail-fast' | 'all-run';

/**
 * Input to the multi-gate executor.
 *
 *  - `cwd` / `phase` — where the gates run and which audit phase (`'pre'` / `'post'`) the row records.
 *  - `gates`     — already-normalised gate list (see {@link normalizeVerifyGates}). When empty,
 *    the run is a no-op recorded as a single `'skipped'` row.
 *  - `scope`     — touched paths (POSIX, repo-root-relative) that filter which gates run. A gate
 *    runs when its `pathPrefix` prefixes ANY scoped path (`''` always matches). `undefined`
 *    means "no scope" → ALL gates run (pre-verify, or a post-verify footprint fallback).
 *  - `mode`      — fail-fast (post) vs all-run (pre). See {@link VerifyGateMode}.
 *  - `defaultTimeoutMs` — repo-level `verifyTimeout` fallback for a gate without its own
 *    `timeoutMs`. The shell runner applies its own default when this too is absent.
 */
export interface RunVerifyGatesProps {
  readonly cwd: AbsolutePath;
  readonly phase: VerifyRunPhase;
  readonly gates: readonly VerifyGate[];
  readonly scope?: readonly string[];
  readonly mode: VerifyGateMode;
  readonly defaultTimeoutMs?: number;
  /** Re-run a real non-zero exit once on an unchanged tree: green → `flakyFailure`, red stands. Pre-verify: off. */
  readonly confirmFailedGateOnce?: ConfirmFailedGate;
  readonly clock: () => IsoTimestamp;
  readonly runShellScript: RunShellScript;
  readonly logger: Logger;
}

/**
 * Normalise the two legacy/structured inputs into ONE gate list so the executor has a single code
 * path. Precedence matches the entity-documented rule: `verifyGates` wins when present AND
 * non-empty; otherwise the legacy `verifyScript` becomes a single catch-all gate
 * `{ pathPrefix: '', command: verifyScript }`. A whitespace-only / absent script with no gates
 * yields `[]` (the executor records a `'skipped'` row).
 */
export const normalizeVerifyGates = (
  verifyScript: string | undefined,
  verifyGates: readonly VerifyGate[] | undefined
): readonly VerifyGate[] => {
  if (verifyGates !== undefined && verifyGates.length > 0) return verifyGates;
  const command = verifyScript?.trim() ?? '';
  if (command.length === 0) return [];
  return [{ pathPrefix: '', command }];
};

/**
 * True iff `gate` should run under `scope`. A `''` prefix is the catch-all and always matches.
 * Otherwise the gate runs when its prefix prefixes ANY touched path. `scope === undefined` means
 * "no scope supplied" → every gate runs (the caller already decided not to filter).
 */
const gateInScope = (gate: VerifyGate, scope: readonly string[] | undefined): boolean => {
  if (scope === undefined) return true;
  if (gate.pathPrefix === '') return true;
  return scope.some((path) => pathUnderPrefix(path, gate.pathPrefix));
};

/**
 * Segment-boundary prefix match. A bare `startsWith` over-matches: prefix `'src'` matches
 * `'src2/a.ts'` and `'lib'` matches `'libs/x'`, so a gate would run against a diff it never
 * touched — failing an attribution on an unrelated, possibly pre-existing-red, gate. Match only
 * when `path` is the prefix exactly or sits under it on a `/` boundary.
 */
const pathUnderPrefix = (path: string, prefix: string): boolean => {
  if (path === prefix) return true;
  const boundary = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return path.startsWith(boundary);
};

/** The first non-success gate, captured so it decides the aggregate row's command/exit/outcome. */
interface GateFailure {
  readonly outcome: 'failed' | 'spawn-error';
  readonly command: string;
  readonly exitCode: number;
  readonly message?: string;
}

/** One executed gate's output; `confirmOutput` only when it was confirm-re-run. */
interface ExecutedGate {
  readonly command: string;
  readonly output: string;
  readonly confirmOutput?: string;
}

/** Re-run only on matching fingerprints: a gate that rewrote the tree (auto-fixer, codegen) would pass falsely. */
export interface ConfirmFailedGate {
  /** Content fingerprint of the working tree's uncommitted state; `undefined` when it can't be taken. */
  readonly treeFingerprint: () => Promise<string | undefined>;
}

/** Mutable accumulator threaded through the gate loop. */
interface GateRunState {
  readonly executed: ExecutedGate[];
  /** First gate that failed then passed its confirm re-run. */
  flaky?: NonNullable<VerifyRun['flakyFailure']>;
  totalDurationMs: number;
  failure?: GateFailure;
}

/**
 * Verify executor — the harness's authoritative read on tree health, run BEFORE the AI (baseline
 * snapshot) and AFTER it commits (independent of the AI's `task-verified` self-report). No policy
 * here; the leaves decide what the outcome means. Runs the scoped subset of `gates` in declaration
 * order and aggregates the per-gate outcomes into ONE {@link VerifyRun}:
 *
 *  - `'skipped'`     — no gate in scope (no script configured). `exitCode = 0`, `durationMs = 0`, no spawn.
 *  - `'success'`     — every executed gate exited 0 (or, with `confirmFailedGateOnce`, failed without
 *    changing the tree, then passed its one confirm re-run — the first such gate is stamped as
 *    `flakyFailure`); `command`
 *    joins the executed gates with `'; '`.
 *  - `'failed'`      — the first non-zero gate decides the row (`command` / `exitCode` point at it).
 *    `fail-fast` stops there; `all-run` still executes (and captures) the remaining gates.
 *  - `'spawn-error'` — the shell could not start a gate. `exitCode = -1`; the error message lands
 *    in `spawnErrorMessage` rather than inside the audit row.
 *
 * `durationMs` sums the executed gates. The audit row carries structured metadata only; the full
 * untruncated output comes back separately as `rawOutput` (behind a `── <command> ──` separator per
 * gate when more than one ran) for the leaf to persist. Total over its inputs — never
 * `Result.error`; spawn-level failures fold into the row so the audit trail captures every run.
 */
export const runVerifyGatesUseCase = async (props: RunVerifyGatesProps): Promise<RunVerifyScriptOutput> => {
  const log = props.logger.named('task.verify-gates');
  const scoped = props.gates.filter((gate) => gateInScope(gate, props.scope));

  if (scoped.length === 0) {
    log.debug('no verify gates in scope, recording skipped row', {
      cwd: props.cwd,
      phase: props.phase,
      totalGates: props.gates.length,
    });
    return {
      run: { phase: props.phase, ranAt: props.clock(), command: '', exitCode: 0, durationMs: 0, outcome: 'skipped' },
      rawOutput: '',
    };
  }

  log.debug(`running ${String(scoped.length)} ${props.phase}-task verify gate(s) (${props.mode})`, {
    cwd: props.cwd,
    scoped: scoped.length,
    total: props.gates.length,
  });

  const startedAt = props.clock();
  const state: GateRunState = { executed: [], totalDurationMs: 0 };

  for (const gate of scoped) {
    await runOneGate(props, log, gate, state);
    // Fail-fast halts at the first non-success; all-run keeps going to complete the baseline.
    if (state.failure !== undefined && props.mode === 'fail-fast') break;
  }

  return projectGateRun(props, startedAt, state, log);
};

/** Run one gate and fold its outcome into `state`. The FIRST non-success captures the failure. */
const runOneGate = async (
  props: RunVerifyGatesProps,
  log: ReturnType<Logger['named']>,
  gate: VerifyGate,
  state: GateRunState
): Promise<void> => {
  const confirm = props.confirmFailedGateOnce;
  const treeBefore = confirm === undefined ? undefined : await confirm.treeFingerprint();
  const result = await spawnGate(props, gate);

  if (!result.ok) {
    log.warn('verify gate could not be executed', {
      cwd: props.cwd,
      phase: props.phase,
      command: gate.command,
      error: result.error.message,
    });
    state.executed.push({ command: gate.command, output: '' });
    state.failure ??= {
      outcome: SPAWN_ERROR_OUTCOME,
      command: gate.command,
      exitCode: -1,
      message: result.error.message,
    };
    return;
  }

  const { passed, exitCode, output, durationMs, timedOut } = result.value;
  state.totalDurationMs += durationMs;
  if (passed) {
    state.executed.push({ command: gate.command, output });
    return;
  }
  // Confirm-on-red only for a gate that exited on its own with a real non-zero code. A timeout /
  // cap kill (`timedOut`) or a null exit (killed / child error) is not a flake signal, so it stays
  // a single red run. Neither is a red run that rewrote the tree (see ConfirmFailedGate).
  if (
    confirm !== undefined &&
    exitCode !== null &&
    exitCode !== 0 &&
    timedOut !== true &&
    (await treeUnchangedByRun(props, log, gate, exitCode, treeBefore, confirm))
  ) {
    await confirmFailedGate(props, log, gate, { exitCode, output }, state);
    return;
  }
  state.executed.push({ command: gate.command, output });
  state.failure ??= { outcome: 'failed', command: gate.command, exitCode: exitCode ?? -1 };
};

/** Fingerprint unchanged by the red run; a missing fingerprint counts as changed. */
const treeUnchangedByRun = async (
  props: RunVerifyGatesProps,
  log: ReturnType<Logger['named']>,
  gate: VerifyGate,
  exitCode: number,
  treeBefore: string | undefined,
  confirm: ConfirmFailedGate
): Promise<boolean> => {
  const treeAfter = await confirm.treeFingerprint();
  if (treeBefore !== undefined && treeAfter === treeBefore) return true;
  const why =
    treeBefore === undefined || treeAfter === undefined ? 'could not be fingerprinted' : 'changed during the run';
  log.warn(
    `verify gate ${gate.command} failed (exit ${String(exitCode)}) and the tree ${why} — no confirm re-run; the red stands`,
    {
      cwd: props.cwd,
      phase: props.phase,
      command: gate.command,
      exitCode,
    }
  );
  return false;
};

/** Spawn one gate with its effective timeout and the lifecycle env. */
const spawnGate = (props: RunVerifyGatesProps, gate: VerifyGate): ReturnType<RunShellScript> => {
  const timeoutMs = gate.timeoutMs ?? props.defaultTimeoutMs;
  return props.runShellScript(props.cwd, gate.command, {
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    env: { RALPHCTL_LIFECYCLE_EVENT: props.phase === 'pre' ? 'pre-task' : 'post-task' },
  });
};

/** Re-run a red gate once; only a green re-run reclassifies it as flaky, anything else keeps the first failure. */
const confirmFailedGate = async (
  props: RunVerifyGatesProps,
  log: ReturnType<Logger['named']>,
  gate: VerifyGate,
  first: { readonly exitCode: number; readonly output: string },
  state: GateRunState
): Promise<void> => {
  const rerun = await spawnGate(props, gate);
  const confirmOutput = rerun.ok
    ? rerun.value.output
    : `[confirm re-run could not be executed: ${rerun.error.message}]`;
  if (rerun.ok) state.totalDurationMs += rerun.value.durationMs;
  state.executed.push({ command: gate.command, output: first.output, confirmOutput });

  if (rerun.ok && rerun.value.passed) {
    log.warn(
      `verify gate ${gate.command} failed (exit ${String(first.exitCode)}) then passed on confirm re-run — recording as flaky`,
      { cwd: props.cwd, phase: props.phase, command: gate.command, exitCode: first.exitCode }
    );
    state.flaky ??= { command: gate.command, exitCode: first.exitCode };
    return;
  }
  state.failure ??= { outcome: 'failed', command: gate.command, exitCode: first.exitCode };
};

/** Project the accumulated gate state into the single aggregated {@link RunVerifyScriptOutput}. */
const projectGateRun = (
  props: RunVerifyGatesProps,
  startedAt: IsoTimestamp,
  state: GateRunState,
  log: ReturnType<Logger['named']>
): RunVerifyScriptOutput => {
  const rawOutput = concatGateOutput(state.executed);
  const { failure, totalDurationMs, executed, flaky } = state;
  if (failure !== undefined) {
    log.info(`${props.phase}-task verify ${failure.outcome}`, { cwd: props.cwd, command: failure.command });
    return {
      run: {
        phase: props.phase,
        ranAt: startedAt,
        command: failure.command,
        exitCode: failure.exitCode,
        durationMs: totalDurationMs,
        outcome: failure.outcome,
      },
      rawOutput,
      ...(failure.message !== undefined ? { spawnErrorMessage: failure.message } : {}),
    };
  }

  log.info(`${props.phase}-task verify success`, {
    cwd: props.cwd,
    gates: executed.length,
    durationMs: totalDurationMs,
  });
  return {
    run: {
      phase: props.phase,
      ranAt: startedAt,
      command: executed.map((e) => e.command).join('; '),
      exitCode: 0,
      durationMs: totalDurationMs,
      outcome: 'success',
      // Persisted so the flake shows in the journal instead of vanishing into a green.
      ...(flaky !== undefined ? { flakyFailure: flaky } : {}),
    },
    rawOutput,
  };
};

/**
 * Concatenate per-gate output behind a `── <command> ──` separator so the single per-phase log
 * file reads cleanly across multiple gates. A single-gate run with no confirm re-run emits the
 * bare output with no separator — byte-for-byte identical to the legacy single-script log. A
 * confirm-re-run gate appends its second output behind `── <command> (confirm re-run) ──`.
 */
const concatGateOutput = (executed: readonly ExecutedGate[]): string => {
  if (executed.length === 0) return '';
  const only = executed.length === 1 ? executed[0] : undefined;
  if (only !== undefined && only.confirmOutput === undefined) return only.output;
  return executed
    .map((e) => {
      const firstRun = `── ${e.command} ──\n${e.output}`;
      return e.confirmOutput === undefined
        ? firstRun
        : `${firstRun}\n\n── ${e.command} (confirm re-run) ──\n${e.confirmOutput}`;
    })
    .join('\n\n');
};

/**
 * Attribution truth table — pure derivation from the two outcomes. Returns `undefined` when
 * attribution can't be determined: pre-verify is `'spawn-error'` (we can't trust the baseline
 * snapshot at all) or either side is `'skipped'` (no script configured — nothing to attribute).
 *
 * Truth table:
 *
 *  - pre=success, post=success → `'clean'`             (incl. a post that passed only on its confirm
 *                                                        re-run — recorded as `flakyFailure`, not blamed)
 *  - pre=success, post=failed  → `'regressed'`         (AI broke a green baseline; blame it. With the
 *                                                        post-verify confirm on, `failed` means the gate
 *                                                        failed on the run AND on the confirm re-run)
 *  - pre=failed,  post=success → `'fixed-baseline'`    (AI repaired a pre-existing failure)
 *  - pre=failed,  post=failed  → `'baseline-broken'`   (pre-existing failure; don't blame AI)
 *  - pre=spawn-error           → undefined             (unknown state; skip attribution)
 *  - pre=skipped OR post=skipped → undefined           (no script; nothing to attribute)
 *  - post=spawn-error          → undefined             (verdict couldn't run)
 */
export const attributeVerify = (
  pre: VerifyRun['outcome'],
  post: VerifyRun['outcome']
): 'clean' | 'regressed' | 'fixed-baseline' | 'baseline-broken' | undefined => {
  if (pre === SPAWN_ERROR_OUTCOME || post === SPAWN_ERROR_OUTCOME) return undefined;
  if (pre === 'skipped' || post === 'skipped') return undefined;
  if (pre === 'success' && post === 'success') return 'clean';
  if (pre === 'success' && post === 'failed') return 'regressed';
  if (pre === 'failed' && post === 'success') return 'fixed-baseline';
  if (pre === 'failed' && post === 'failed') return 'baseline-broken';
  return undefined;
};
