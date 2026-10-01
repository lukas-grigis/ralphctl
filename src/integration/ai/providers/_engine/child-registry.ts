import type { AiProvider } from '@src/domain/entity/settings.ts';

/** One headless AI CLI child, as the provider engine knows it at spawn time. */
export interface RegisteredChild {
  readonly pid: number;
  /** Set when the child leads its own process group — the group the orphan reaper kills. */
  readonly pgid?: number;
  readonly provider: AiProvider;
  readonly command: string;
  readonly cwd: string;
  readonly role?: 'generator' | 'evaluator';
  /** The spawn's `signals.json`; its directory also holds `session-id.txt` and names the round. */
  readonly signalsFile: string;
}

/** Handle for one registered child; `release` once the child has exited. */
export interface RegisteredChildHandle {
  noteSessionId(sessionId: string): void;
  release(): void;
}

/**
 * Where headless spawns announce their children so they can be reaped if the harness dies and
 * recorded for crash recovery. Wired in `wire()`; tests and one-shot callers use
 * {@link NOOP_CHILD_REGISTRY}.
 */
export interface ChildRegistry {
  register(child: RegisteredChild): RegisteredChildHandle;
}

const NOOP_HANDLE: RegisteredChildHandle = {
  noteSessionId: () => {},
  release: () => {},
};

export const NOOP_CHILD_REGISTRY: ChildRegistry = { register: () => NOOP_HANDLE };
