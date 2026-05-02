/**
 * `mountInkApp(options)` — entry point for the Ink-based TUI.
 *
 * Detects whether the current environment supports Ink (interactive TTY +
 * not CI/piped). When supported, mounts the Ink React tree with the right
 * initial view, wires `InkPromptAdapter` + `InkSink` into SharedDeps, and
 * awaits `waitUntilExit()` before returning.
 *
 * In non-TTY environments returns `{ fallback: true }` so the caller can
 * run the same logic with the PlainTextSink logger and no interactive
 * prompts (CI mode).
 *
 */

import React from 'react';
import { render } from 'ink';
import { getSharedDeps, setSharedDeps } from '@src/application/bootstrap/get-shared-deps.ts';
import { InkSink } from '@src/integration/logging/ink-sink.ts';
import { InkPromptAdapter } from '@src/integration/ui/prompts/prompt-adapter.ts';
import { registerExternalHost } from '@src/integration/ui/prompts/auto-mount.tsx';
import { App } from '@src/application/tui/views/app.tsx';
import { enterAltScreen, exitAltScreen } from './screen.ts';
import { logEventBus } from './event-bus.ts';
import { isFirstLaunch } from '@src/application/runtime/first-launch.ts';
import { installShutdownHandlers, registerShutdown } from '@src/application/runtime/shutdown.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import type { ViewId, ViewEntry } from '@src/application/tui/views/router-context.ts';

export interface MountOptions {
  /** Which view to open initially. Defaults to 'home'. */
  readonly initialView?: ViewId;
  /** For the 'execute' view: which session to attach to. */
  readonly sessionId?: string;
}

interface MountResult {
  /** True when the environment can't host Ink — caller should run a fallback. */
  fallback: boolean;
}

function canMountInk(): boolean {
  if (process.env['RALPHCTL_NO_TUI']) return false;
  if (process.env['CI']) return false;
  if (process.env['RALPHCTL_JSON']) return false;
  if (!process.stdout.isTTY) return false;
  if (!process.stdin.isTTY) return false;
  return true;
}

export async function mountInkApp(options: MountOptions = {}): Promise<MountResult> {
  if (!canMountInk()) {
    return { fallback: true };
  }

  // Swap in Ink-aware sinks before mounting.
  const deps = await getSharedDeps();
  const inkLogger = new InkSink(logEventBus);
  const inkPrompt = new InkPromptAdapter();
  setSharedDeps({ ...deps, logger: inkLogger, prompt: inkPrompt });

  // First-launch detection: when the user has no projects and no current
  // sprint, drop them straight into project-add (above home so Esc / `h`
  // still pop back to the pipeline map). The probe runs against the same
  // SharedDeps the rest of the TUI uses so a failed read silently
  // degrades to the normal home root.
  const initialStack = await resolveInitialStack(deps, options);

  // Install the shutdown coordinator BEFORE entering the alt-screen so
  // the screen-restore registered inside enterAltScreen() runs through
  // the same pipeline as the session-manager dispose. Order of register
  // determines order of invocation on shutdown — sessions abort first
  // so their final terminal output flushes before alt-screen restore
  // pulls the terminal out from under them.
  installShutdownHandlers();
  const unregisterDispose = registerShutdown('session-manager', async () => {
    await deps.sessionManager.dispose();
  });

  enterAltScreen();
  const releaseHost = registerExternalHost();

  const app = render(
    <App
      initialView={options.initialView}
      sessionManager={deps.sessionManager}
      sessionId={options.sessionId}
      signalBus={deps.signalBus}
      initialStack={initialStack}
    />,
    { exitOnCtrlC: false }
  );

  try {
    await app.waitUntilExit();
  } finally {
    unregisterDispose();
    releaseHost();
    exitAltScreen();
    // Restore plain-text logger and prompt on exit.
    setSharedDeps({ ...deps });
  }

  return { fallback: false };
}

/**
 * Resolves the initial navigation stack. When the caller passed
 * `initialView` / `sessionId` we honor that explicit intent. Otherwise we
 * probe for first-launch state (no projects + no current sprint) and seed
 * `[home, project-add]` so the user lands on the form with home one Esc
 * away.
 */
async function resolveInitialStack(deps: SharedDeps, options: MountOptions): Promise<readonly ViewEntry[] | undefined> {
  if (options.initialView !== undefined) return undefined;
  const firstLaunch = await isFirstLaunch({ projectRepo: deps.projectRepo, configStore: deps.configStore });
  if (!firstLaunch) return undefined;
  return [{ id: 'home' }, { id: 'project-add', props: { firstLaunch: true } }];
}
