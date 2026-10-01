import type {
  ChildRegistry,
  RegisteredChild,
  RegisteredChildHandle,
} from '@src/integration/ai/providers/_engine/child-registry.ts';
import type { OrphanReaper } from '@src/integration/io/orphan-reaper.ts';
import type { LiveRunRecorder } from '@src/application/session/live-run-recorder.ts';

/** The wired {@link ChildRegistry}: reaper registration, live-run record updates, and a live-child count. */
export interface RunChildRegistry extends ChildRegistry {
  liveChildren(): number;
  /** Resolves once no registered child is running. */
  whenNoChildren(): Promise<void>;
}

export interface RunChildRegistryDeps {
  readonly reaper: OrphanReaper;
  readonly recorder: Pick<LiveRunRecorder, 'spawnStarted'>;
  /** The run a spawn belongs to — the outermost chain session at the spawn site. */
  readonly runIdOf: () => string | undefined;
}

export const createRunChildRegistry = (deps: RunChildRegistryDeps): RunChildRegistry => {
  let live = 0;
  let waiters: Array<() => void> = [];

  const register = (child: RegisteredChild): RegisteredChildHandle => {
    live += 1;
    if (child.pgid !== undefined) deps.reaper.watch(child.pgid);
    const runId = deps.runIdOf();
    const recorded = runId === undefined ? undefined : deps.recorder.spawnStarted(runId, child);
    let released = false;
    return {
      noteSessionId: (sessionId) => recorded?.noteSessionId(sessionId),
      release: () => {
        if (released) return;
        released = true;
        live -= 1;
        if (child.pgid !== undefined) deps.reaper.unwatch(child.pgid);
        recorded?.exited();
        if (live > 0) return;
        const done = waiters;
        waiters = [];
        for (const resolve of done) resolve();
      },
    };
  };

  return {
    register,
    liveChildren: () => live,
    whenNoChildren: () => (live === 0 ? Promise.resolve() : new Promise((resolve) => waiters.push(resolve))),
  };
};
