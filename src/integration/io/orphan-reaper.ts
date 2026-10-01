import type { ChildProcess } from 'node:child_process';
import { crossPlatformSpawn } from '@src/integration/io/cross-platform-spawn.ts';
import { supportsProcessGroups } from '@src/integration/io/kill-process-tree.ts';

/**
 * Orphan reaper: a tiny detached Node sidecar that outlives the harness only long enough to kill
 * what the harness left behind. The harness holds the write end of the sidecar's stdin and streams
 * `+<pgid>` / `-<pgid>` lines as AI CLI process groups come and go. When that pipe closes — the
 * harness exited, crashed, or was SIGKILLed; the kernel closes the fd either way — the sidecar
 * SIGTERMs every group still registered, waits `graceMs`, SIGKILLs them, and exits.
 *
 * The sidecar is started lazily on the first `watch`, so a process that never spawns a headless
 * AI CLI never forks it. It is `unref`'d (process and pipe) so it never keeps the harness alive.
 * POSIX only — Windows has no process groups; there the boot-time reap of dead runs' records is
 * the only cleanup.
 */
export interface OrphanReaper {
  watch(pgid: number): void;
  unwatch(pgid: number): void;
}

export const DEFAULT_REAPER_GRACE_MS = 3_000;

/**
 * Inline so the sidecar needs no asset path (tsup splits chunks; dev runs from source). Plain
 * CommonJS for `node -e`; argv[1] is the grace window.
 */
const REAPER_SOURCE = `
const graceMs = Number(process.argv[1]) > 0 ? Number(process.argv[1]) : ${String(DEFAULT_REAPER_GRACE_MS)};
const groups = new Set();
let buffered = '';
let reaping = false;
const signalAll = (sig) => { for (const g of groups) { try { process.kill(-g, sig); } catch {} } };
const reap = () => {
  if (reaping) return;
  reaping = true;
  if (groups.size === 0) process.exit(0);
  signalAll('SIGTERM');
  setTimeout(() => { signalAll('SIGKILL'); process.exit(0); }, graceMs);
};
for (const sig of ['SIGINT', 'SIGHUP', 'SIGPIPE']) process.on(sig, () => {});
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffered += chunk;
  let nl;
  while ((nl = buffered.indexOf('\\n')) >= 0) {
    const line = buffered.slice(0, nl);
    buffered = buffered.slice(nl + 1);
    const pgid = Number(line.slice(1));
    if (!Number.isInteger(pgid) || pgid <= 1) continue;
    if (line[0] === '+') groups.add(pgid);
    else if (line[0] === '-') groups.delete(pgid);
  }
});
process.stdin.on('end', reap);
process.stdin.on('close', reap);
process.stdin.on('error', reap);
`;

export interface OrphanReaperDeps {
  readonly graceMs?: number;
  /** Test seam: starts the sidecar. Defaults to `node -e <source> <graceMs>` via `crossPlatformSpawn`. */
  readonly startSidecar?: (graceMs: number) => ChildProcess;
}

const defaultStartSidecar = (graceMs: number): ChildProcess =>
  crossPlatformSpawn(process.execPath, ['-e', REAPER_SOURCE, String(graceMs)], {
    stdio: ['pipe', 'ignore', 'ignore'],
    detached: true,
    // A loader in NODE_OPTIONS (tsx under `pnpm dev`, vitest's) would only slow the sidecar's start.
    env: { ...process.env, NODE_OPTIONS: '' },
  });

/** A reaper that does nothing — Windows, or after the sidecar failed to start. */
const NOOP_REAPER: OrphanReaper = { watch: () => {}, unwatch: () => {} };

export const createOrphanReaper = (deps: OrphanReaperDeps = {}): OrphanReaper => {
  if (!supportsProcessGroups()) return NOOP_REAPER;
  const graceMs = deps.graceMs ?? DEFAULT_REAPER_GRACE_MS;
  const start = deps.startSidecar ?? defaultStartSidecar;
  let sidecar: ChildProcess | undefined;
  let broken = false;

  const ensureSidecar = (): ChildProcess | undefined => {
    if (broken) return undefined;
    if (sidecar !== undefined) return sidecar;
    try {
      const child = start(graceMs);
      const fail = (): void => {
        broken = true;
      };
      child.once('error', fail);
      child.once('exit', fail);
      child.stdin?.on('error', fail);
      child.unref();
      (child.stdin as { unref?: () => void } | null)?.unref?.();
      sidecar = child;
      return child;
    } catch {
      broken = true;
      return undefined;
    }
  };

  const send = (line: string): void => {
    const child = ensureSidecar();
    if (child?.stdin === null || child?.stdin === undefined || broken) return;
    try {
      child.stdin.write(`${line}\n`);
    } catch {
      broken = true;
    }
  };

  return {
    watch: (pgid) => send(`+${String(pgid)}`),
    unwatch: (pgid) => {
      if (sidecar !== undefined) send(`-${String(pgid)}`);
    },
  };
};
