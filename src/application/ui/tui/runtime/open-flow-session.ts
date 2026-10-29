/**
 * `openFlowSession` — the register + start + route tail shared by every TUI call site that
 * launches a flow runner. Given a successful {@link LaunchResult}, it:
 *
 *   1. Registers the runner with the {@link SessionManager} together with the launch result's UI hints.
 *   2. Fires `runner.start()` (fire-and-forget — events flow into the session manager via the
 *      manager's own subscription, established during `register`).
 *   3. Routes to the Execute view for the new runner's session id — pushing a new frame by
 *      default, or replacing the current frame when `opts.mode === 'replace'`.
 *
 * Centralised so the launch call sites (flows / home / pick-sprint / project-detail / sprints,
 * plus the create-sprint copies folded into {@link useLaunchCreateSprint}) don't each re-stamp
 * the same three-statement tail. Flows-view passes `mode: 'replace'` and runs its own
 * `reload()` afterwards; the reload stays at the call site because it is flows-view-specific.
 */

import type { RouterApi, ViewEntry } from '@src/application/ui/tui/runtime/router.tsx';
import type { SessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import type { LaunchResult } from '@src/application/ui/shared/launcher.ts';

export interface OpenFlowSessionDeps {
  readonly sessions: SessionManager;
  readonly router: RouterApi;
}

export interface OpenFlowSessionOpts {
  /**
   * How to route to the Execute view. `push` (default) stacks a new frame so `Esc` returns to
   * the launching view; `replace` swaps the current frame (flows-view uses this so the menu
   * isn't left on the stack behind the run).
   */
  readonly mode?: 'push' | 'replace';
}

export const openFlowSession = (
  deps: OpenFlowSessionDeps,
  result: Extract<LaunchResult, { readonly ok: true }>,
  flowId: string,
  opts: OpenFlowSessionOpts = {}
): void => {
  const { ok: _ok, runner, title, ...hints } = result;
  void _ok;
  deps.sessions.register({ runner, flowId, title, ...hints });
  // Fire-and-forget — the session manager already subscribed during register(), so progress
  // events land there without further wiring here.
  void runner.start();
  const entry: ViewEntry = { id: 'execute', props: { sessionId: runner.id } };
  if (opts.mode === 'replace') deps.router.replace(entry);
  else deps.router.push(entry);
};
