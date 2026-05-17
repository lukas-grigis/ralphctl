/**
 * Branded string identifying a previously-started AI session that can be resumed.
 *
 * The shape is opaque to the port — the adapter knows what its own session ids look like.
 * For Claude, this is the `session_id` value emitted on the first JSON line of the
 * stdout stream; the adapter forwards it to `--resume <id>` on a follow-up call.
 *
 * Pure type, no runtime — keeping it in `domain/` does not pull integration code into
 * the domain layer.
 */
declare const __sessionId: unique symbol;
export type SessionId = string & { readonly [__sessionId]: 'SessionId' };
