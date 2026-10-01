/**
 * `openFlowSession` — the register + start + route tail shared by every TUI call site that launches a flow runner:
 * registers it with the {@link SessionManager}, fires `runner.start()`, then pushes (or replaces) the Execute view.
 * @public
 */

import type { RouterApi, ViewEntry } from '@src/application/ui/tui/runtime/router.tsx';
import type { SessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import { type LaunchResult, sessionHintsFromLaunchResult } from '@src/application/ui/shared/launcher.ts';

export interface OpenFlowSessionDeps {
  readonly sessions: SessionManager;
  readonly router: RouterApi;
}

export interface OpenFlowSessionOpts {
  /** How to route to the Execute view. */
  readonly mode?: 'push' | 'replace';
}

export const openFlowSession = (
  deps: OpenFlowSessionDeps,
  result: Extract<LaunchResult, { readonly ok: true }>,
  flowId: string,
  opts: OpenFlowSessionOpts = {}
): void => {
  deps.sessions.register({
    runner: result.runner,
    flowId,
    title: result.title,
    ...sessionHintsFromLaunchResult(result),
  });
  // Fire-and-forget — the session manager already subscribed during register(), so progress
  // events land there without further wiring here.
  void result.runner.start();
  const entry: ViewEntry = { id: 'execute', props: { sessionId: result.runner.id } };
  if (opts.mode === 'replace') deps.router.replace(entry);
  else deps.router.push(entry);
};
