/**
 * How a rendered prompt reaches an interactive AI CLI: as a POINTER to the file the harness
 * already wrote, never as the body.
 *
 * The body used to travel as a plain argv element, which put every interactive session one long
 * `PRIOR_PROGRESS` section away from `spawn ENAMETOOLONG` on Windows — the plan template alone is
 * ~22 KB before a single substitution, against a 32,767-byte command line (see `argv-budget.ts`).
 * A pointer is a fixed ~250 bytes regardless of prompt size, so argv size stops tracking prompt
 * size at all.
 *
 * Every adapter grants its CLI read access to the pointer's directory and nothing wider:
 * `--add-dir` for claude / copilot / codex, and a path-scoped `external_directory` config grant for
 * OpenCode, which has no such flag. A CLI that could be granted nothing at all has no place in this
 * port — inlining the body for it would just move the same overflow one layer down — so it should
 * be rejected where the adapter is declared, not quietly handed an unbounded command line.
 *
 * Two earlier answers to the same problem are on the rejected list and must not come back:
 * `bash -lc "claude … \"$(cat promptFile)\""` (Windows backslash paths do not survive `cat` inside
 * bash, bash cannot execute the npm / winget `.cmd` shims, and it silently dropped the seed on
 * Copilot) and `shell: true` for binary+args (mis-quotes arguments containing spaces or `& | % "`).
 * The pointer needs neither — it is an ordinary argument to a directly-spawned binary.
 */

/**
 * The argv element handed to the CLI in place of the prompt body.
 *
 * Deliberately ONE line: on Windows `cross-spawn` folds every argument into a single
 * `cmd.exe /d /s /c "…"` string when it resolves a `.cmd` shim, and an embedded CR/LF there is a
 * command separator rather than text. The path is passed absolute — `cwd` is the per-run sandbox
 * for some flows and the repository for others, so a relative path would resolve differently
 * depending on which flow launched the session.
 */
export const buildPromptPointer = (promptFile: string): string =>
  `Your complete instructions for this session are in the file ${promptFile}. Read that entire file first, before any other action, then carry out exactly what it says — it is the full brief, already written to disk, so there is nothing further to wait for or ask about.`;
