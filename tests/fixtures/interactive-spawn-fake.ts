import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type { InteractiveSpawn } from '@src/integration/ai/providers/_engine/interactive-spawn.ts';

/**
 * Capturing `InteractiveSpawn` fake shared by the interactive-adapter suites and the shared-engine
 * suite. Each of those files carried its own byte-identical copy, which drifted the moment one of
 * them needed to observe something new — so the fake records everything an adapter can pass
 * (including `env`) and can emit either ending (`close` or a spawn-level `error`), rather than each
 * suite seeing only the half its file happened to grow.
 *
 * `env` is recorded as handed to the spawn — the merge over `process.env` belongs to
 * `defaultInteractiveSpawn`, and a fake that pre-merged it would hide what the adapter declared.
 *
 * @public
 */
export interface InteractiveSpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Signals sent to this child, in order. The fake never dies of them — a `stdio: 'inherit'`
   * child that trapped SIGTERM is exactly the case `attachAbortKill`'s grace timer exists for, so
   * discarding the signal (as the fake used to) made the SIGTERM → SIGKILL escalation
   * unassertable. Tests end the session explicitly with `emitExit`.
   */
  readonly kills: readonly NodeJS.Signals[];
}

/** @public */
export interface CapturingInteractiveSpawn {
  readonly spawn: InteractiveSpawn;
  readonly calls: readonly InteractiveSpawnCall[];
  /** End the most recent session with an exit code, as a real child's `close` event would. */
  readonly emitExit: (code: number | null) => void;
  /** Fail the most recent session at spawn level (the async `'error'` event). */
  readonly emitError: (cause: Error) => void;
}

/** @public */
export const makeInteractiveSpawn = (): CapturingInteractiveSpawn => {
  const calls: Array<InteractiveSpawnCall & { kills: NodeJS.Signals[] }> = [];
  const last = {
    child: undefined as (ChildProcess & { emit: (event: string, ...args: unknown[]) => boolean }) | undefined,
  };

  const spawn: InteractiveSpawn = (command, args, options) => {
    const kills: NodeJS.Signals[] = [];
    calls.push({
      command,
      args,
      cwd: options.cwd,
      ...(options.env !== undefined ? { env: options.env } : {}),
      kills,
    });
    const child = new EventEmitter() as unknown as ChildProcess & {
      emit: (event: string, ...args: unknown[]) => boolean;
    };
    // `attachAbortKill` calls `child.kill` on abort — the fake needs it to be callable.
    (child as unknown as { kill: (signal?: NodeJS.Signals) => boolean }).kill = (signal): boolean => {
      kills.push(signal ?? 'SIGTERM');
      return true;
    };
    last.child = child;
    return child;
  };

  return {
    spawn,
    calls,
    emitExit: (code) => {
      setTimeout(() => last.child?.emit('close', code), 0);
    },
    emitError: (cause) => {
      setTimeout(() => last.child?.emit('error', cause), 0);
    },
  };
};
