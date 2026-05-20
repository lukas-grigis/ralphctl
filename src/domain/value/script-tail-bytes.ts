/**
 * Fixed cap (in bytes) on how much of stdout / stderr a structured script-run audit row
 * preserves. 4 KB is enough to capture the last "pnpm install" summary block or the final
 * stack frame of a spawn failure without bloating the on-disk JSON when a script is noisy.
 *
 * Shared between {@link SetupRun} (`sprint-execution.ts`) and {@link CheckRun} (`attempt.ts`)
 * so both audit shapes use the same truncation point — one constant, one place to retune.
 * @public
 */
export const SCRIPT_TAIL_BYTES = 4096;
