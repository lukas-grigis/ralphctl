import type { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { VerifyRun, VerifyRunOutcome, VerifyRunPhase } from '@src/domain/entity/attempt.ts';
import type { VerifyGate } from '@src/domain/entity/repository.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

/** {@link VerifyRunOutcome} value for a verify command the shell could not start. */
const SPAWN_ERROR_OUTCOME = 'spawn-error';

/**
 * Generic helper that runs the project's `verifyScript` once and projects the spawn result
 * into a structured {@link VerifyRun} row. Phase-agnostic — callers stamp `phase: 'pre'` or
 * `phase: 'post'` per call site.
 *
 * Belt-and-braces independent verification: this is the harness's authoritative read on
 * tree health, used both BEFORE the AI runs (baseline snapshot) and AFTER it commits
 * (independent of the AI's `task-verified` self-report). No policy here — the leaves layer
 * decides what to do with the outcome (attribution, blocking, warnings).
 *
 * Outcomes mirror {@link SetupRun} semantics:
 *
 *  - `'skipped'`     — no script configured (or whitespace-only). `exitCode = 0`, `durationMs = 0`.
 *  - `'success'`     — script exited 0.
 *  - `'failed'`      — script exited non-zero.
 *  - `'spawn-error'` — shell could not start the command. `exitCode = -1`; the spawn error
 *                      message lands in `spawnErrorMessage` (rather than inside the audit row).
 *
 * The audit row carries structured metadata only; the full untruncated output is returned
 * separately so the caller can persist it to `<sprintDir>/logs/verify/<task-id>/...` per
 * audit-[01].
 */
export interface RunVerifyScriptProps {
  readonly cwd: AbsolutePath;
  readonly phase: VerifyRunPhase;
  readonly verifyScript?: string;
  readonly timeoutMs?: number;
  readonly clock: () => IsoTimestamp;
  readonly runShellScript: (
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
      },
      StorageError
    >
  >;
  readonly logger: Logger;
}

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

/**
 * Total over its inputs — never returns `Result.error`. Even spawn-level failures are folded
 * into the structured row (`outcome: 'spawn-error'`) so the audit trail captures every attempt,
 * including the ones the harness couldn't start. Caller decides whether the outcome blocks the
 * chain (it doesn't, by policy — see the leaves).
 */
export const runVerifyScriptUseCase = async (props: RunVerifyScriptProps): Promise<RunVerifyScriptOutput> => {
  const log = props.logger.named('task.verify-script');
  const command = props.verifyScript?.trim() ?? '';

  if (command.length === 0) {
    log.debug('no verify script configured, recording skipped row', { cwd: props.cwd, phase: props.phase });
    return {
      run: {
        phase: props.phase,
        ranAt: props.clock(),
        command: '',
        exitCode: 0,
        durationMs: 0,
        outcome: 'skipped',
      },
      rawOutput: '',
    };
  }

  log.debug(`running ${props.phase}-task verify`, { cwd: props.cwd, timeoutMs: props.timeoutMs });

  const startedAt = props.clock();
  const result = await props.runShellScript(props.cwd, command, {
    ...(props.timeoutMs !== undefined ? { timeoutMs: props.timeoutMs } : {}),
    env: { RALPHCTL_LIFECYCLE_EVENT: props.phase === 'pre' ? 'pre-task' : 'post-task' },
  });

  if (!result.ok) {
    // Spawn-level failure (binary missing, permission denied, …). Folded into the structured
    // row as `'spawn-error'` rather than propagated as a Result.error — the leaf treats it as
    // an unknown-state signal and skips attribution.
    log.warn('verify script could not be executed', {
      cwd: props.cwd,
      phase: props.phase,
      error: result.error.message,
    });
    return {
      run: {
        phase: props.phase,
        ranAt: startedAt,
        command,
        exitCode: -1,
        durationMs: 0,
        outcome: SPAWN_ERROR_OUTCOME,
      },
      rawOutput: '',
      spawnErrorMessage: result.error.message,
    };
  }

  const { passed, exitCode, output, durationMs } = result.value;
  const outcome: VerifyRunOutcome = passed ? 'success' : 'failed';
  log.info(`${props.phase}-task verify ${outcome}`, { cwd: props.cwd, exitCode, durationMs });
  return {
    run: {
      phase: props.phase,
      ranAt: startedAt,
      command,
      exitCode: exitCode ?? -1,
      durationMs,
      outcome,
    },
    rawOutput: output,
  };
};

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
 * Input to the multi-gate executor. Mirrors {@link RunVerifyScriptProps} for the shared fields
 * and adds the gate list, the optional touched-path scope, and the run mode.
 *
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
  readonly clock: () => IsoTimestamp;
  readonly runShellScript: RunVerifyScriptProps['runShellScript'];
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

/**
 * Multi-gate verify executor — the WS3 generalisation of {@link runVerifyScriptUseCase}. Runs the
 * scoped subset of `gates` in declaration order and aggregates the per-gate outcomes into ONE
 * {@link VerifyRun} so the existing attempt/attribution shape is untouched:
 *
 *  - `outcome` is `'success'` only when EVERY executed gate succeeded. The first non-success
 *    decides the aggregate outcome (`'failed'` / `'spawn-error'`), and in `fail-fast` mode the
 *    run stops there; in `all-run` mode the remaining gates still execute (their output is still
 *    captured) but the aggregate outcome stays the first failure's.
 *  - `command` reports what actually ran: the failing gate's command on a failure (so the audit
 *    row points at the culprit), else the `'; '`-joined commands of every executed gate.
 *  - `exitCode` is the failing gate's exit code (or `0` when all passed; `-1` for spawn-error).
 *  - `durationMs` sums the executed gates.
 *  - `rawOutput` concatenates each executed gate's output behind a clear `── <command> ──`
 *    separator so the single per-phase log file stays readable.
 *
 * An empty (post-filter) gate set records a `'skipped'` row — same contract as the no-script
 * path. Total over its inputs (never `Result.error`); spawn-level failures fold into the row.
 */
/** The first non-success gate, captured so it decides the aggregate row's command/exit/outcome. */
interface GateFailure {
  readonly outcome: 'failed' | 'spawn-error';
  readonly command: string;
  readonly exitCode: number;
  readonly message?: string;
}

/** Mutable accumulator threaded through the gate loop. */
interface GateRunState {
  readonly executed: Array<{ readonly command: string; readonly output: string }>;
  totalDurationMs: number;
  failure?: GateFailure;
}

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
  const timeoutMs = gate.timeoutMs ?? props.defaultTimeoutMs;
  const result = await props.runShellScript(props.cwd, gate.command, {
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    env: { RALPHCTL_LIFECYCLE_EVENT: props.phase === 'pre' ? 'pre-task' : 'post-task' },
  });

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

  const { passed, exitCode, output, durationMs } = result.value;
  state.totalDurationMs += durationMs;
  state.executed.push({ command: gate.command, output });
  if (!passed) state.failure ??= { outcome: 'failed', command: gate.command, exitCode: exitCode ?? -1 };
};

/** Project the accumulated gate state into the single aggregated {@link RunVerifyScriptOutput}. */
const projectGateRun = (
  props: RunVerifyGatesProps,
  startedAt: IsoTimestamp,
  state: GateRunState,
  log: ReturnType<Logger['named']>
): RunVerifyScriptOutput => {
  const rawOutput = concatGateOutput(state.executed);
  const { failure, totalDurationMs, executed } = state;
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
    },
    rawOutput,
  };
};

/**
 * Concatenate per-gate output behind a `── <command> ──` separator so the single per-phase log
 * file reads cleanly across multiple gates. A single-gate run emits the bare output with no
 * separator — byte-for-byte identical to the legacy single-script log.
 */
const concatGateOutput = (executed: ReadonlyArray<{ readonly command: string; readonly output: string }>): string => {
  if (executed.length === 0) return '';
  if (executed.length === 1) return executed[0]?.output ?? '';
  return executed.map((e) => `── ${e.command} ──\n${e.output}`).join('\n\n');
};

/**
 * Attribution truth table — pure derivation from the two outcomes. Returns `undefined` when
 * attribution can't be determined: pre-verify is `'spawn-error'` (we can't trust the baseline
 * snapshot at all) or either side is `'skipped'` (no script configured — nothing to attribute).
 *
 * Truth table:
 *
 *  - pre=success, post=success → `'clean'`
 *  - pre=success, post=failed  → `'regressed'`         (AI broke a green baseline; blame it)
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
