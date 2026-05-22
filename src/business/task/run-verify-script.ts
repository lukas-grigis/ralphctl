import type { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { VerifyRun, VerifyRunOutcome, VerifyRunPhase } from '@src/domain/entity/attempt.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { SCRIPT_TAIL_BYTES } from '@src/domain/value/script-tail-bytes.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

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
 *                      message lands in `stdoutTailBytes` since the row carries only one tail.
 *
 * Truncation uses {@link SCRIPT_TAIL_BYTES} (shared with `SetupRun`) so both audit shapes
 * stay aligned.
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
 * Use-case output. `run` is the persisted-shape audit row; `rawOutput` carries the full
 * untruncated stdout+stderr so the leaf can persist it to `<sprintDir>/logs/verify/...` per
 * audit [01] / [03]. Empty string for `skipped` / `spawn-error` outcomes — there's no spawn
 * output to capture.
 */
export interface RunVerifyScriptOutput {
  readonly run: VerifyRun;
  readonly rawOutput: string;
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
        stdoutTailBytes: '',
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
        stdoutTailBytes: result.error.message,
        outcome: 'spawn-error',
      },
      rawOutput: '',
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
      stdoutTailBytes: tailBytes(output, SCRIPT_TAIL_BYTES),
      outcome,
    },
    rawOutput: output,
  };
};

/** Return the last `limit` bytes of `s` (utf-8), prefixing an ellipsis marker if truncated. */
const tailBytes = (s: string, limit: number): string => {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= limit) return s;
  const tail = buf.subarray(buf.length - limit).toString('utf8');
  return `…[truncated ${String(buf.length - limit)} bytes]\n${tail}`;
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
 *
 * @public
 */
export const attributeVerify = (
  pre: VerifyRun['outcome'],
  post: VerifyRun['outcome']
): 'clean' | 'regressed' | 'fixed-baseline' | 'baseline-broken' | undefined => {
  if (pre === 'spawn-error' || post === 'spawn-error') return undefined;
  if (pre === 'skipped' || post === 'skipped') return undefined;
  if (pre === 'success' && post === 'success') return 'clean';
  if (pre === 'success' && post === 'failed') return 'regressed';
  if (pre === 'failed' && post === 'success') return 'fixed-baseline';
  if (pre === 'failed' && post === 'failed') return 'baseline-broken';
  return undefined;
};
