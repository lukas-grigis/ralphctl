import { basename, join } from 'node:path';
import { writeTextAtomic } from '@src/integration/io/fs.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';

/**
 * The setup-script leaf's output reporting — the persisted full log and the failure surfaces (log
 * rows, banner, error) — split out of `setup-script-runner.ts`, which keeps the run / resume /
 * audit logic.
 */

/** Per-line cap for setup-script tail rows surfaced to the TUI. JS code units; see comment
 *  on the call site for why graphemes are overkill for ralphctl's actual content. */
const BANNER_LINE_MAX = 200;
/** Number of recent non-blank lines kept on the bus when a setup-script fails. */
const MAX_TAIL_LINES = 20;
/** Display-clip marker (audit-[03]). Mirrors `glyphs.clipEllipsis` in TUI tokens — duplicated
 *  here because the chains layer cannot import from UI (ESLint fence). One char, U+2026. */
const CLIP_ELLIPSIS = '…';
/** Event-bus event type for dismissible TUI banners. Named constant so the string literal
 *  doesn't drift across the several publish sites. */
export const BANNER_SHOW = 'banner-show';

/**
 * Marker emitted by pnpm 11's `removeModulesDirSafe` when it wants to wipe `node_modules`
 * but can't prompt for confirmation. Tracked separately so the dependency on pnpm's error
 * shape is explicit — when pnpm renames or restructures the error, only this constant moves.
 * See pnpm/pnpm#9966 for the breaking-change context.
 */
const PNPM_NO_TTY_ERROR_MARKER = 'ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY';

export interface SetupReportDeps {
  readonly clock: () => IsoTimestamp;
  readonly eventBus: EventBus;
  /**
   * Atomic whole-file writer for the persisted setup log — see {@link persistSetupLog}. Optional:
   * callers that don't wire the port fall back to the direct `writeTextAtomic` adapter, so
   * behaviour is unchanged either way.
   */
  readonly writeFile?: WriteFile;
}

/** The repo a report is about. */
export interface SetupReportRepo {
  readonly repositoryId: RepositoryId;
  readonly path: AbsolutePath;
}

/** Fallback `WriteFile` for callers that don't (yet) wire the port — same atomic adapter either way. */
const defaultWriteFile: WriteFile = (path, content) => writeTextAtomic(String(path), content);

/**
 * Builds the failure error for a setup script that spawned but exited non-zero: detects the
 * pnpm-no-TTY marker for a targeted hint, surfaces the last few output lines as error-level
 * logs (audit-[03]: clip at display, never at persistence), and shows the failed-gate banner.
 * Returns the `InvalidStateError` for the caller to wrap in `Result.error`.
 */
export const buildSetupFailureError = (
  repo: SetupReportRepo,
  command: string,
  exitCode: number | null,
  output: string,
  deps: SetupReportDeps
): DomainError => {
  // pnpm 11 hardened `removeModulesDirSafe` to abort on missing TTY rather than
  // silently re-creating `node_modules` (pnpm/pnpm#9966 / #11562). The shell runner
  // now sets `CI=true` (+ `PNPM_CONFIG_FROZEN_LOCKFILE=false`) on every setup/verify
  // child — the only lever that suppresses this on pnpm 11, where every
  // `confirm-modules-purge=false` form is ignored. So this marker should fire only when
  // `CI` has been explicitly overridden in the operator's environment; the hint points
  // there rather than asking the project under development to adapt.
  const noTtyDetected = output.includes(PNPM_NO_TTY_ERROR_MARKER);
  const pnpmTtyHint = noTtyDetected
    ? 'pnpm no-TTY abort. The harness sets `CI=true` (+ `PNPM_CONFIG_FROZEN_LOCKFILE=false`) on setup/verify to prevent this — `CI` looks overridden in your environment. Clear `CI`, or run the install once in a terminal to resync `node_modules`.'
    : undefined;
  deps.eventBus.publish({
    type: 'log',
    level: 'error',
    message: `setup-script ${String(repo.path)}: failed (exit=${String(exitCode ?? 'null')})`,
    at: deps.clock(),
  });
  publishOutputTail(repo, output, deps);
  deps.eventBus.publish({
    type: BANNER_SHOW,
    id: `setup-script-${String(repo.repositoryId)}`,
    tier: 'error',
    message: `Setup script failed for ${String(repo.path)}: ${command}`,
    cause:
      pnpmTtyHint !== undefined
        ? `exit ${String(exitCode ?? 'null')} — ${pnpmTtyHint}`
        : `exit ${String(exitCode ?? 'null')}`,
    at: deps.clock(),
  });
  return new InvalidStateError({
    entity: 'sprint',
    currentState: 'pre-implement',
    attemptedAction: 'setup-script',
    // The rail row already prefixes `setup-script · <repo>`; the message stays
    // minimal so the operator's eye is not retracing the same name. The full
    // command + path are in the banner / log / execution.json audit row.
    message:
      pnpmTtyHint !== undefined
        ? `exited ${String(exitCode ?? 'null')} (no-tty pnpm)`
        : `exited ${String(exitCode ?? 'null')}`,
    hint: pnpmTtyHint ?? 'Inspect <sprintDir>/logs/setup/<repo-id>.log for the failing repo and fix the environment.',
  });
};

/**
 * Surface the last few lines of script output as error-level logs so the TUI's Recent-log tail
 * renders the actionable bit alongside the headline. The full output already landed verbatim at
 * `<sprintDir>/logs/setup/<repo-id>.log`; these bus events are a *display* surface, so per-line +
 * per-count clipping is valid here (audit-[03]: clip at display, never at persistence).
 *
 * Clip unit: JS string `.length` (UTF-16 code units) at the per-line cap. ralphctl's setup output
 * is shell stdout — overwhelmingly ASCII (paths, exit codes, npm/pnpm diagnostic strings);
 * grapheme-aware clipping via Intl.Segmenter would be overkill for the actual content. A
 * pathological emoji-in-script string could be split mid-surrogate, in which case Ink renders the
 * broken pair as a replacement glyph — still visually obvious that the line was clipped. If/when
 * we surface user-authored prose through this path, switch to Intl.Segmenter and update the
 * banner-clip unit test fixtures.
 */
const publishOutputTail = (repo: SetupReportRepo, output: string, deps: SetupReportDeps): void => {
  const tailLines = output
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .slice(-MAX_TAIL_LINES);
  const totalCount = output.split('\n').filter((l) => l.trim().length > 0).length;
  const elided = Math.max(0, totalCount - tailLines.length);
  const repoBasename = basename(String(repo.path));
  if (elided > 0) {
    // Multi-line collapse marker: signals to the operator that earlier lines were
    // dropped from this surface (the full log is on disk).
    deps.eventBus.publish({
      type: 'log',
      level: 'error',
      message: `setup-script (${repoBasename}): ${CLIP_ELLIPSIS} ${String(elided)} earlier line${elided === 1 ? '' : 's'} elided — full log at logs/setup/${String(repo.repositoryId)}.log`,
      at: deps.clock(),
    });
  }
  for (const line of tailLines) {
    const clipped = line.length > BANNER_LINE_MAX ? `${line.slice(0, BANNER_LINE_MAX - 1)}${CLIP_ELLIPSIS}` : line;
    deps.eventBus.publish({
      type: 'log',
      level: 'error',
      message: `setup-script (${repoBasename}): ${clipped}`,
      at: deps.clock(),
    });
  }
};

/**
 * Audit [01] / [03]: persist the full untruncated setup-script output to
 * `<sprintDir>/logs/setup/<repo-id>.log` so the operator can grep / tail the real failure.
 * Best-effort — a write failure logs warn and never aborts the chain (the audit row remains
 * canonical). No-op when `sprintDir` is unset (test paths that don't care about disk logs).
 */
export const persistSetupLog = async (
  deps: SetupReportDeps,
  sprintDir: AbsolutePath | undefined,
  repo: SetupReportRepo,
  output: string
): Promise<void> => {
  if (sprintDir === undefined) return;
  const logPath = join(String(sprintDir), 'logs', 'setup', `${String(repo.repositoryId)}.log`);
  const parsedPath = AbsolutePath.parse(logPath);
  if (!parsedPath.ok) {
    deps.eventBus.publish({
      type: 'log',
      level: 'warn',
      message: `setup-script ${String(repo.path)}: could not resolve log path ${logPath} — ${parsedPath.error.message}`,
      at: deps.clock(),
    });
    return;
  }
  const writeFile = deps.writeFile ?? defaultWriteFile;
  const wrote = await writeFile(parsedPath.value, output);
  if (!wrote.ok) {
    deps.eventBus.publish({
      type: 'log',
      level: 'warn',
      message: `setup-script ${String(repo.path)}: failed to persist full log to ${logPath} — ${wrote.error.message}`,
      at: deps.clock(),
    });
  }
};
