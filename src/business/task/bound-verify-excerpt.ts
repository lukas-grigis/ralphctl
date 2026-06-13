/**
 * Bound a verify-script output excerpt before it is persisted onto a `verify-failed`
 * {@link import('@src/domain/entity/attempt.ts').AttemptWarning}.
 *
 * The shell-script runner caps a single verify spawn's combined stdout+stderr at 50 MB. That
 * full body is the in-process settle handoff on `ctx.lastVerifyResult.stderr` (audit-[03]) and
 * is written verbatim to `<sprintDir>/logs/verify/<task-id>/...` — the on-disk source of truth.
 * `settle-attempt` then copies it onto the attempt's `verify-failed` warning, which is PERSISTED
 * with the task (`tasks.json`) and retained in `ctx.tasks` for the whole sprint. Persisting the
 * full body there re-creates the exact OOM class that drove dropping `Verification.output` (see
 * the `Verification` docstring in `attempt.ts`): every failed attempt across the sprint pins its
 * full verify spawn buffer — on a verbose toolchain (e.g. `mvn clean verify`) that is tens of MB
 * per attempt × every task, and it climbs until V8 OOMs the harness.
 *
 * The warning excerpt only ever feeds a one-line display (sprint-detail clips to the first
 * non-blank line + 120 chars) and the journal / PR-body summary, so bounding it loses nothing
 * the operator reads in-app — the full log stays on disk. We keep the HEAD (so the existing
 * first-non-blank-line display is byte-for-byte unchanged for short output) AND the TAIL (verify
 * tools print the actual failure at the end), with a one-line marker between that points back at
 * the on-disk log.
 *
 * Pure. Bounds by character length (≈ bytes for the ASCII-dominant verify logs this guards).
 *
 * @public
 */

/** Hard cap on the persisted verify excerpt. 8 KiB comfortably holds the head + the failing
 * tail of any real verify run while pinning worst-case memory at ~8 KB per attempt instead of
 * the runner's 50 MB ceiling. */
export const VERIFY_WARNING_EXCERPT_LIMIT = 8 * 1024;

export const boundVerifyExcerpt = (output: string, limit: number = VERIFY_WARNING_EXCERPT_LIMIT): string => {
  if (limit <= 0 || output.length <= limit) return output;
  const head = Math.floor(limit / 4);
  const tail = limit - head;
  const dropped = output.length - head - tail;
  return `${output.slice(0, head)}\n…[${String(dropped)} chars truncated — full verify log on disk]…\n${output.slice(output.length - tail)}`;
};
