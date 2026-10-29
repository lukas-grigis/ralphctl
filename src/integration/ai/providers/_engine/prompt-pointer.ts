/**
 * A rendered prompt reaches the CLI as a POINTER at the file the harness wrote, never as the body:
 * the body put interactive sessions one long section away from `spawn ENAMETOOLONG` on Windows
 * (`argv-budget.ts`), while a pointer is a fixed ~250 bytes. Each adapter grants its CLI read
 * access to the pointer's directory; a CLI that can be granted nothing does not belong on this
 * port. The rejected alternatives (`bash -lc "… $(cat promptFile)"`, `shell: true`) are listed in
 * `.claude/docs/SECURITY.md`.
 */

/**
 * Deliberately ONE line: when `cross-spawn` routes a `.cmd` shim through `cmd.exe`, an embedded
 * CR/LF is a command separator. The path stays absolute because `cwd` differs between flows.
 */
export const buildPromptPointer = (promptFile: string): string =>
  `Your complete instructions for this session are in the file ${promptFile}. Read that entire file first, before any other action, then carry out exactly what it says — it is the full brief, already written to disk; any questions or approvals it asks you to put to the operator are expected.`;
