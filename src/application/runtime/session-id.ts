/**
 * Per-process session id used to name `<logsDir>/<session-id>.jsonl`.
 *
 * 8-character base36 string, deterministic enough for grep, random enough
 * to avoid collisions across concurrent invocations on the same machine.
 *
 * The id is generated once per process — `createSharedDeps()` accepts it
 * as an override so tests and the Ink mount path can pass a known value.
 */
export function generateSessionId(): string {
  // 4 base36 chars per Math.random().toString(36).slice(2, 6) ≈ 20 bits each.
  // Concatenating two windows gives ~40 bits, enough that two concurrent
  // `ralphctl` invocations are extremely unlikely to clash.
  const a = Math.random().toString(36).slice(2, 6).padStart(4, '0');
  const b = Math.random().toString(36).slice(2, 6).padStart(4, '0');
  return `${a}${b}`;
}
