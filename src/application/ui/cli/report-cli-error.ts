/**
 * Shared CLI failure reporter — every command action ends a failed branch with
 * `fail(message); return;` (or `return <value>;` in a helper with a non-`void` return type)
 * instead of hand-rolling the `process.stderr.write` + `process.exitCode = 1` pair. Consolidates
 * the `error: ` prefix and trailing newline in one place so every command's stderr output stays
 * byte-identical to what it was before this was extracted.
 */
export const fail = (message: string): void => {
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
};
