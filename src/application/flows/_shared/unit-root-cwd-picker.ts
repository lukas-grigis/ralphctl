import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { assertCtxField } from '@src/application/flows/_shared/_engine/assert-ctx-field.ts';

/**
 * Minimal ctx shape every flow that materialises a per-run sandbox directory already satisfies.
 *
 * @public
 */
export interface UnitRootCtx {
  readonly currentUnitRoot?: AbsolutePath;
}

/**
 * Shared `cwdPicker` for leaves that must run inside the per-run sandbox directory rather than a
 * project repository — the skills install / uninstall pair bracketing an AI session, and anything
 * else rooted at `ctx.currentUnitRoot`. Rooting those sessions in a repo would auto-load that
 * repo's agent + tooling context and bias the AI toward it.
 *
 * `leafName` names the consuming leaf in the thrown error, so a chain that forgot to materialise
 * the sandbox first fails at the leaf that actually broke instead of with a generic message.
 *
 * @public
 */
export const unitRootCwdPicker =
  <TCtx extends UnitRootCtx>(leafName: string) =>
  (ctx: TCtx): AbsolutePath =>
    assertCtxField(ctx, 'currentUnitRoot', leafName, 'pre-ai-session');
