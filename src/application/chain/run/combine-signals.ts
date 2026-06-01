/**
 * Combine a chain's host abort signal with a secondary one (e.g. the `FileLocker`'s
 * lock-compromised signal) into a single signal that aborts when EITHER fires. When the host
 * signal is absent, the secondary is returned unchanged.
 *
 * Used so a compromised whole-run lock tears the chain down the same way a user Ctrl+C does: the
 * lock holder threads its compromise signal in here and passes the result to `element.execute`,
 * so a lock lost mid-run propagates as an ordinary `AbortError` through the chain.
 *
 * @public
 */
export const combineAbortSignals = (host: AbortSignal | undefined, secondary: AbortSignal): AbortSignal =>
  host === undefined ? secondary : AbortSignal.any([host, secondary]);
