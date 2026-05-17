import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

/**
 * Run the project-configured check script after the per-task commit. Three outcomes:
 *
 *   - no script configured → `{ kind: 'skipped' }`
 *   - script ran green     → `{ kind: 'passed' }`
 *   - script ran red       → `{ kind: 'verify-failed', exitCode, stderr }` (non-fatal — the
 *                            settle step decides whether to attach this as an AttemptWarning)
 *
 * Spawn-level errors (binary missing, permission denied) DO halt the chain — infrastructure
 * failures, not domain decisions. Stderr is truncated to the last 4KB before being surfaced.
 */
export type PostTaskCheckOutput =
  | { readonly kind: 'skipped' }
  | { readonly kind: 'passed' }
  | { readonly kind: 'verify-failed'; readonly exitCode: number | null; readonly stderr: string };

export interface PostTaskCheckProps {
  readonly cwd: AbsolutePath;
  readonly checkScript?: string;
  readonly timeoutMs?: number;
  readonly runShellScript: (
    cwd: AbsolutePath,
    script: string,
    opts: { readonly timeoutMs?: number; readonly env?: Readonly<Record<string, string>> }
  ) => Promise<
    Result<{ readonly passed: boolean; readonly exitCode: number | null; readonly output: string }, StorageError>
  >;
  readonly logger: Logger;
}

const STDERR_TRUNCATE_BYTES = 4096;

const truncate = (s: string, maxBytes: number): string => {
  const buf = Buffer.from(s, 'utf8');
  if (buf.byteLength <= maxBytes) return s;
  return `${buf.subarray(buf.byteLength - maxBytes).toString('utf8')}\n[stderr truncated to last ${String(maxBytes)} bytes]`;
};

export const postTaskCheckUseCase = async (
  props: PostTaskCheckProps
): Promise<Result<PostTaskCheckOutput, StorageError>> => {
  const log = props.logger.named('task.post-check');

  if (props.checkScript === undefined || props.checkScript.trim().length === 0) {
    log.debug('no check script configured, skipping', { cwd: props.cwd });
    return Result.ok({ kind: 'skipped' });
  }

  log.debug('running post-task check', { cwd: props.cwd, timeoutMs: props.timeoutMs });

  const result = await props.runShellScript(props.cwd, props.checkScript, {
    ...(props.timeoutMs !== undefined ? { timeoutMs: props.timeoutMs } : {}),
    env: { RALPHCTL_LIFECYCLE_EVENT: 'post-task' },
  });
  if (!result.ok) {
    log.error('check script could not be executed', { cwd: props.cwd, error: result.error.message });
    return Result.error(result.error);
  }

  if (result.value.passed) {
    log.info('post-task check passed', { cwd: props.cwd });
    return Result.ok({ kind: 'passed' });
  }

  const stderr = truncate(result.value.output, STDERR_TRUNCATE_BYTES);
  log.warn(`post-task check failed (exit=${String(result.value.exitCode ?? 'null')})`, {
    cwd: props.cwd,
    exitCode: result.value.exitCode,
  });
  return Result.ok({ kind: 'verify-failed', exitCode: result.value.exitCode, stderr });
};
