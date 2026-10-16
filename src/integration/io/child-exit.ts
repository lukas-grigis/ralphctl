import type { ChildProcessWithoutNullStreams } from 'node:child_process';

/** How long to wait for buffered output after the child exits before giving up on its pipes. */
export const EXIT_DRAIN_MS = 1_000;

/**
 * Calls `onDone` once with the child's exit code: on `close`, or `drainMs` after `exit` when
 * something the child forked still holds its stdout/stderr — `close` waits for every holder of
 * the pipes, so a backgrounded or daemonised grandchild would otherwise stall the caller for its
 * whole lifetime. `pipesHeld` tells the caller which of the two settled it.
 */
export const onChildDone = (
  child: ChildProcessWithoutNullStreams,
  onDone: (code: number | null, pipesHeld: boolean) => void,
  drainMs: number = EXIT_DRAIN_MS
): void => {
  let done = false;
  let drain: NodeJS.Timeout | undefined;
  const settle = (code: number | null, pipesHeld: boolean): void => {
    if (done) return;
    done = true;
    clearTimeout(drain);
    onDone(code, pipesHeld);
  };
  child.on('close', (code: number | null) => {
    settle(code, false);
  });
  child.once('exit', (code: number | null) => {
    drain = setTimeout(() => {
      child.stdout.destroy();
      child.stderr.destroy();
      settle(code, true);
    }, drainMs);
  });
};
