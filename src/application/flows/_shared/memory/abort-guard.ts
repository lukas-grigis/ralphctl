/**
 * True when a thrown read error is the result of an aborted `AbortSignal`. Node surfaces this as
 * an `Error` with `name === 'AbortError'` and `code === 'ABORT_ERR'`; we also treat an already-
 * fired signal as decisive in case the runtime races the throw.
 *
 * Shared by the memory leaves (`load-learnings`, `stamp-promoted`) so the "a cancelled read must
 * re-propagate `AbortError`, never collapse into an empty ledger" contract is enforced one way.
 *
 * @public
 */
export const isAbortedRead = (cause: unknown, signal: AbortSignal | undefined): boolean => {
  if (signal?.aborted === true) return true;
  if (cause instanceof Error) {
    if (cause.name === 'AbortError') return true;
    if ((cause as { code?: unknown }).code === 'ABORT_ERR') return true;
  }
  return false;
};
