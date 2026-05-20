/**
 * OS-backed {@link NotificationDispatcher}. Two side channels per notification:
 *
 *   1. Terminal bell — `process.stdout.write('\x07')`. Cross-platform, audible on most terminal
 *      emulators, and free even when the user has muted the OS notification daemon. Always
 *      fires regardless of platform (so a remote-tmux session still gets a ding).
 *   2. OS notification daemon — best-effort shell-out per platform:
 *        - darwin: `osascript -e 'display notification "<body>" with title "<title>"'`
 *        - linux:  `notify-send "<title>" "<body>"` (skipped when `notify-send` is not on PATH)
 *        - other:  skipped (Windows would need a PowerShell wrapper — out of scope for v0.7.0).
 *
 * "Best-effort" is the contract: a missing binary, a daemon refusing the request, an `osascript`
 * timeout — all absorbed silently. The dispatcher logs at debug level so the operator can opt in
 * to seeing what failed via `RALPHCTL_LOG_LEVEL=debug`, but the bell still fires either way.
 *
 * Quoting is the awkward bit on macOS. The `osascript -e '<literal>'` invocation puts the AppleScript
 * source on the argv, then AppleScript itself parses double-quoted string literals — so we have to
 * escape backslashes and double quotes for AppleScript's parser. The single-quoted shell layer is
 * handled by `execFile` (which doesn't go through a shell, so single-quote escaping isn't needed).
 * Newlines are stripped because AppleScript string literals can't contain a raw newline.
 *
 * Platform detection is done once at adapter construction time via `os.platform()`. Tests inject
 * a fake `platform()` to exercise each branch without depending on the host OS.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { platform as osPlatform } from 'node:os';
import type { Logger } from '@src/business/observability/logger.ts';
import type { NotificationDispatcher } from '@src/business/observability/notification-dispatcher.ts';

const execFile = promisify(execFileCb);

/** Hard wall-clock cap on `osascript` / `notify-send` / `which notify-send`. */
const SHELL_TIMEOUT_MS = 5_000;

/** Terminal bell control character. */
const BELL = '\x07';

export interface OsNotificationDispatcherDeps {
  readonly logger: Logger;
  /**
   * Test seam — defaults to `os.platform()`. Production paths never inject; only tests do, so the
   * Darwin / Linux / Windows branches can be exercised cross-platform.
   */
  readonly platform?: () => NodeJS.Platform;
  /**
   * Test seam — defaults to `node:child_process.execFile` (promisified). Tests inject a fake to
   * assert the exact argv passed to `osascript` / `notify-send` without invoking real binaries.
   */
  readonly execFile?: (
    command: string,
    args: readonly string[],
    options: { readonly timeout: number }
  ) => Promise<{ readonly stdout: string; readonly stderr: string }>;
  /**
   * Test seam — defaults to `process.stdout.write('\x07')`. Tests inject a recorder so we can
   * assert the bell fires regardless of whether the OS dispatch path succeeded.
   */
  readonly emitBell?: () => void;
}

const defaultEmitBell = (): void => {
  // Best-effort: writing to a closed stdout (rare, but happens during Ink unmount races) throws.
  try {
    process.stdout.write(BELL);
  } catch {
    // ignore — the OS path is the secondary signal anyway.
  }
};

const defaultExecFile = (
  command: string,
  args: readonly string[],
  options: { readonly timeout: number }
): Promise<{ readonly stdout: string; readonly stderr: string }> =>
  execFile(command, [...args], { timeout: options.timeout }).then((r) => ({
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
  }));

/**
 * Build the OS-backed dispatcher. Construction is pure — no shell-outs until `notify(...)` is
 * called.
 */
export const createOsNotificationDispatcher = (deps: OsNotificationDispatcherDeps): NotificationDispatcher => {
  const platform = deps.platform ?? osPlatform;
  const run = deps.execFile ?? defaultExecFile;
  const bell = deps.emitBell ?? defaultEmitBell;
  const log = deps.logger.named('notifications');

  return {
    async notify(level, title, body) {
      // Always ring the bell first — even if the OS path falls over, the operator still gets the
      // audible cue. Synchronous; no need to await.
      bell();

      const plat = platform();
      try {
        if (plat === 'darwin') {
          await dispatchDarwin(run, title, body);
          return;
        }
        if (plat === 'linux') {
          await dispatchLinux(run, title, body);
          return;
        }
        // Other platforms (win32, freebsd, ...) — bell only. Logged at debug so the operator can
        // see why no notification appeared if they're investigating.
        log.debug('OS notification skipped — platform not supported', { platform: plat, level });
      } catch (err) {
        // Best-effort: a thrown adapter must not surface to the caller. The contract is "tell the
        // operator if we can; otherwise stay out of the way".
        log.debug('OS notification failed', {
          platform: plat,
          level,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
};

const dispatchDarwin = async (
  run: NonNullable<OsNotificationDispatcherDeps['execFile']>,
  title: string,
  body: string | undefined
): Promise<void> => {
  // AppleScript string literals: escape backslash + double-quote; strip newlines (literal `\n`
  // is not valid inside an AppleScript double-quoted string passed via `-e`).
  const safeTitle = escapeAppleScript(title);
  const safeBody = body !== undefined ? escapeAppleScript(body) : '';
  const script = `display notification "${safeBody}" with title "${safeTitle}"`;
  await run('osascript', ['-e', script], { timeout: SHELL_TIMEOUT_MS });
};

const dispatchLinux = async (
  run: NonNullable<OsNotificationDispatcherDeps['execFile']>,
  title: string,
  body: string | undefined
): Promise<void> => {
  // Probe for `notify-send` first — skip silently if it isn't installed. `which` exits non-zero
  // when not found, which `execFile` surfaces as a thrown error caught by the caller.
  try {
    await run('which', ['notify-send'], { timeout: SHELL_TIMEOUT_MS });
  } catch {
    // Not installed — bell only. No log here; the per-platform debug already covers absence.
    return;
  }
  const args = body !== undefined ? [title, body] : [title];
  await run('notify-send', args, { timeout: SHELL_TIMEOUT_MS });
};

const escapeAppleScript = (s: string): string =>
  s.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', ' ');
