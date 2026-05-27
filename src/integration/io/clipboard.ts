/**
 * Cross-platform clipboard writer. Best-effort: every implementation pipes the payload to a
 * native helper via stdin and resolves regardless of whether the helper succeeded — the operator
 * can always paste the markdown manually from the chain log if the system clipboard is unhappy
 * (no DISPLAY, no `pbcopy`, sandboxed Wayland session, …).
 *
 *   - Darwin                → `pbcopy`
 *   - Linux (Wayland)       → `wl-copy`
 *   - Linux (X11) fallback  → `xclip -selection clipboard`
 *   - Windows               → `clip.exe`
 *
 * The platform/tool selection is fixed at module construction; we do NOT race multiple helpers
 * because that risks visible flicker in the user's clipboard and double-spawned children if the
 * caller mashes the hotkey. Linux probes Wayland (`WAYLAND_DISPLAY` env) first, X11 (`DISPLAY`)
 * second; if neither is set we still try `wl-copy` then `xclip` in order — a headless server may
 * have one of them wired through systemd-user even without a session env.
 *
 * Errors are NEVER thrown. The `copyToClipboard` API returns a `Result<void, ClipboardError>`
 * for callers that want to log debug-level diagnostics; the TUI's `y` hotkey ignores the error
 * and surfaces a "copy failed" banner if `ok === false`.
 *
 * Spawn is injected so unit tests can script stdin / exit codes deterministically.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { Result } from '@src/domain/result.ts';
import type { Spawn } from '@src/integration/io/spawn.ts';

/** Sentinel error tag so callers can branch on the cause without parsing strings. */
export type ClipboardErrorCode = 'no-helper' | 'spawn-failed' | 'helper-nonzero' | 'unsupported-platform';

/** @public */
export interface ClipboardError {
  readonly code: ClipboardErrorCode;
  readonly message: string;
}

export type CopyToClipboard = (text: string) => Promise<Result<void, ClipboardError>>;

interface HelperCommand {
  readonly cmd: string;
  readonly args: readonly string[];
}

interface PlatformProbeOptions {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * Resolve the ordered list of helpers to try for the current host. Returns at least one entry on
 * every supported platform — the caller still folds the eventual ENOENT into a `no-helper`
 * error if the binary is missing at spawn time.
 */
const resolveHelpers = ({ platform, env }: PlatformProbeOptions): readonly HelperCommand[] => {
  if (platform === 'darwin') return [{ cmd: 'pbcopy', args: [] }];
  if (platform === 'win32') return [{ cmd: 'clip.exe', args: [] }];
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') {
    const wayland = typeof env['WAYLAND_DISPLAY'] === 'string' && env['WAYLAND_DISPLAY'].length > 0;
    const ordered: HelperCommand[] = [];
    if (wayland) {
      ordered.push({ cmd: 'wl-copy', args: [] });
      ordered.push({ cmd: 'xclip', args: ['-selection', 'clipboard'] });
    } else {
      ordered.push({ cmd: 'xclip', args: ['-selection', 'clipboard'] });
      ordered.push({ cmd: 'wl-copy', args: [] });
    }
    return ordered;
  }
  return [];
};

const runHelper = (spawn: Spawn, helper: HelperCommand, text: string): Promise<Result<void, ClipboardError>> =>
  new Promise((resolve) => {
    let child: ReturnType<Spawn>;
    try {
      child = spawn(helper.cmd, helper.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (cause) {
      resolve(
        Result.error({
          code: 'spawn-failed',
          message: `clipboard helper '${helper.cmd}' could not be spawned: ${String((cause as Error)?.message ?? cause)}`,
        })
      );
      return;
    }
    let settled = false;
    const settle = (r: Result<void, ClipboardError>): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    child.on('error', (cause) => {
      // ENOENT lands here when the binary isn't on PATH.
      const code = (cause as NodeJS.ErrnoException).code === 'ENOENT' ? 'no-helper' : 'spawn-failed';
      settle(Result.error({ code, message: `clipboard helper '${helper.cmd}' failed: ${cause.message}` }));
    });
    child.on('close', (exitCode) => {
      if (exitCode === 0) {
        settle(Result.ok(undefined));
        return;
      }
      settle(
        Result.error({
          code: 'helper-nonzero',
          message: `clipboard helper '${helper.cmd}' exited with code ${String(exitCode ?? 'null')}`,
        })
      );
    });

    // `wl-copy` keeps a background daemon by default and only writes the selection once stdin
    // closes; the same closes signal `pbcopy` / `xclip` (with `-selection`) and `clip.exe`. The
    // first write therefore needs to be the last write — encode the whole payload at once.
    try {
      child.stdin.end(text, 'utf8');
    } catch (cause) {
      settle(
        Result.error({
          code: 'spawn-failed',
          message: `clipboard helper '${helper.cmd}' stdin write failed: ${String((cause as Error)?.message ?? cause)}`,
        })
      );
    }
  });

/** @public */
export interface CreateCopyToClipboardOptions {
  /** Override `node:child_process.spawn` in tests. */
  readonly spawn?: Spawn;
  /** Override `process.platform` in tests. */
  readonly platform?: NodeJS.Platform;
  /** Override `process.env` in tests. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Build a clipboard-copy adapter for the current platform. Falls through every helper in order
 * — when one returns `no-helper` (binary missing) we try the next; any other error is returned
 * as-is. On platforms without a known helper the adapter returns `unsupported-platform` on every
 * invocation so the TUI hotkey can surface "clipboard unavailable" without spawning anything.
 */
export const createCopyToClipboard = (opts: CreateCopyToClipboardOptions = {}): CopyToClipboard => {
  const spawn = opts.spawn ?? (nodeSpawn as Spawn);
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const helpers = resolveHelpers({ platform, env });

  return async (text) => {
    if (helpers.length === 0) {
      return Result.error({
        code: 'unsupported-platform',
        message: `clipboard not supported on platform '${platform}'`,
      });
    }
    let lastError: ClipboardError | undefined;
    for (const helper of helpers) {
      const result = await runHelper(spawn, helper, text);
      if (result.ok) return result;
      lastError = result.error;
      if (result.error.code !== 'no-helper') return result;
    }
    return Result.error(
      lastError ?? {
        code: 'no-helper',
        message: 'no clipboard helper found on PATH',
      }
    );
  };
};
