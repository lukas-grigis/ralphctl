import { isAbsolute, relative, resolve } from 'node:path';

/**
 * How a rendered prompt reaches an interactive AI CLI: as a POINTER to the file the harness
 * already wrote, never as the body itself.
 *
 * The body used to travel as a plain argv element, which put every interactive session one long
 * `PRIOR_PROGRESS` section away from `spawn ENAMETOOLONG` on Windows — the plan template alone is
 * ~22 KB before a single substitution, against a 32,767-byte command line (see `argv-budget.ts`).
 * A pointer is a fixed ~250 bytes regardless of prompt size, so argv size stops tracking prompt
 * size at all.
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

/** Case-fold only where the filesystem does, so a `C:\Users` / `c:\users` mismatch is not a miss. */
const forCompare = (path: string): string => (process.platform === 'win32' ? path.toLowerCase() : path);

/** Whether `candidate` resolves to a location inside `root` (a path equal to the root does not count). */
const isWithin = (root: string, candidate: string): boolean => {
  const rel = relative(forCompare(resolve(root)), forCompare(resolve(candidate)));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/**
 * Whether the CLI will actually be able to open the prompt file — the pointer is only safe when it
 * is, because a CLI that cannot read the path fails by starting an empty session rather than by
 * erroring, which is far harder to diagnose than the overflow it replaced.
 *
 * `mountsRoots` says the adapter has some way to grant its CLI access to the prompt file's
 * directory, whatever that mechanism is: `--add-dir` for claude / copilot / codex, and a scoped
 * `external_directory` config grant for OpenCode, which has no such flag. All four can today, so
 * the second arm is a safety net rather than a live path — it exists so a future adapter for a CLI
 * that cannot be granted anything degrades to a working (if large) argv instead of opening a
 * session that silently has no instructions. `cwd` is a per-run sandbox for plan and refine but a
 * repository for ideate and memory-distill, so where the prompt sits relative to it is a runtime
 * question, not a per-provider constant.
 */
export const isPromptFileReachable = (cwd: string, promptFile: string, mountsRoots: boolean): boolean =>
  mountsRoots || isWithin(cwd, promptFile);
