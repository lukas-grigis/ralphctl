/**
 * Argv-size accounting shared by the interactive engine and the headless spawn classifier.
 *
 * Windows caps a process command line at 32,767 characters including the terminating null
 * (`CreateProcessW` / `lpCommandLine`), and `cmd.exe` — which `cross-spawn` routes through when it
 * resolves an npm / winget `.cmd` shim — caps at 8,191. The two fail differently, and the second
 * one is the nastier of the pair:
 *
 *  - above 32,767 the spawn fails outright and Node surfaces `ENAMETOOLONG` (win32) or `E2BIG`
 *    (darwin / linux);
 *  - between 8,191 and 32,767 `CreateProcess` SUCCEEDS and `cmd.exe` silently truncates, so the
 *    child starts with a mangled command line and no error is raised anywhere.
 *
 * Nothing here can prevent the silent band — only keeping prompt bodies out of argv does that (see
 * `prompt-pointer.ts`). What this module provides is the diagnosis: a byte count for the message,
 * and a predicate that recognises an overflow even when the errno is unhelpful. Overflow does not
 * always arrive as `ENAMETOOLONG`; the same condition has been observed surfacing as
 * `ERROR_INVALID_PARAMETER` on Windows, so the byte count is checked alongside the errno rather
 * than trusting the errno alone.
 */

/** `CreateProcessW` `lpCommandLine` ceiling, including the terminating null. */
const WINDOWS_COMMAND_LINE_LIMIT = 32_767;

/**
 * `cmd.exe` ceiling. Not enforced here — it is the SILENT band, so there is no error to classify —
 * but it is the number the hint quotes when explaining why staying well under the ceiling matters.
 */
const CMD_EXE_COMMAND_LINE_LIMIT = 8_191;

/** Best-effort errno for any thrown or emitted spawn cause, including a non-`Error` rejection. */
export const errnoOf = (cause: unknown): string | undefined =>
  cause instanceof Error ? ((cause as NodeJS.ErrnoException).code ?? cause.name) : undefined;

/** Total bytes a command line occupies: the binary, every argument, and one separator each. */
export const argvByteLength = (command: string, args: readonly string[]): number =>
  args.reduce((total, arg) => total + Buffer.byteLength(arg, 'utf8') + 1, Buffer.byteLength(command, 'utf8'));

/**
 * Whether a spawn failure is an argv / command-line overflow. Matches the two errnos the kernels
 * raise, plus any failure at all once the assembled command line is already past the Windows
 * ceiling — at that size no other explanation is more likely, and the errno cannot be relied on.
 */
export const isArgvOverflow = (errno: string | undefined, argvBytes: number): boolean =>
  errno === 'ENAMETOOLONG' || errno === 'E2BIG' || argvBytes >= WINDOWS_COMMAND_LINE_LIMIT;

/**
 * The actionable half of an overflow message. Names the measured size against the ceiling it
 * breached so the next occurrence identifies itself instead of arriving as a bare errno — and
 * points at the prompt file, because an oversized argv on this codebase means a prompt body leaked
 * back into it.
 */
export const argvOverflowHint = (argvBytes?: number, promptFile?: string): string =>
  `command line is past the ${String(WINDOWS_COMMAND_LINE_LIMIT)}-byte Windows limit` +
  `${argvBytes === undefined ? '' : ` (measured ${String(argvBytes)} bytes)`}` +
  ` (${String(CMD_EXE_COMMAND_LINE_LIMIT)} when a .cmd shim routes through cmd.exe) — ` +
  `the prompt body belongs in ${promptFile ?? 'a file the CLI reads'}, not in argv`;
