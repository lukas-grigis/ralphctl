/** Renders any thrown/caught value into a display string — `Error.message` when it is an `Error`, `String(cause)` otherwise. */
export const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
