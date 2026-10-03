import type {
  ChildRegistry,
  RegisteredChild,
  RegisteredChildHandle,
} from '@src/integration/ai/providers/_engine/child-registry.ts';
import type { OrphanReaper } from '@src/integration/io/orphan-reaper.ts';
import type { LiveRunRecorder } from '@src/application/session/live-run-recorder.ts';
import { signalProcessGroup } from '@src/integration/io/kill-process-tree.ts';

/** The wired {@link ChildRegistry}: reaper registration, live-run record updates, and a live-child count. */
export interface RunChildRegistry extends ChildRegistry {
  liveChildren(): number;
  /** Resolves once no registered child is running. */
  whenNoChildren(): Promise<void>;
  /** SIGKILLs each live child's group (or lone pid); returns how many were signalled. */
  killAll(): number;
}

export interface RunChildRegistryDeps {
  readonly reaper: OrphanReaper;
  readonly recorder: Pick<LiveRunRecorder, 'spawnStarted'>;
  /** The run a spawn belongs to — the outermost chain session at the spawn site. */
  readonly runIdOf: () => string | undefined;
  /** Test seam for the forced kill; returns whether the signal was delivered. */
  readonly kill?: (child: RegisteredChild) => boolean;
}

const sigkill = (child: RegisteredChild): boolean => {
  if (child.pgid !== undefined) return signalProcessGroup(child.pgid, 'SIGKILL');
  try {
    process.kill(child.pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
};

export const createRunChildRegistry = (deps: RunChildRegistryDeps): RunChildRegistry => {
  let waiters: Array<() => void> = [];
  const running = new Set<RegisteredChild>();

  const register = (child: RegisteredChild): RegisteredChildHandle => {
    running.add(child);
    if (child.pgid !== undefined) deps.reaper.watch(child.pgid);
    const runId = deps.runIdOf();
    const recorded = runId === undefined ? undefined : deps.recorder.spawnStarted(runId, child);
    let released = false;
    return {
      noteSessionId: (sessionId) => recorded?.noteSessionId(sessionId),
      release: () => {
        if (released) return;
        released = true;
        running.delete(child);
        if (child.pgid !== undefined) deps.reaper.unwatch(child.pgid);
        recorded?.exited();
        if (running.size > 0) return;
        const done = waiters;
        waiters = [];
        for (const resolve of done) resolve();
      },
    };
  };

  return {
    register,
    liveChildren: () => running.size,
    whenNoChildren: () => (running.size === 0 ? Promise.resolve() : new Promise((resolve) => waiters.push(resolve))),
    killAll: () => [...running].filter((child) => (deps.kill ?? sigkill)(child)).length,
  };
};
