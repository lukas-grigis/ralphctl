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
 * Ported from src/integration/ui/tui/runtime/mount.tsx — adapted for src/.
 */

import React from 'react';
import { render } from 'ink';
import { getSharedDeps, setSharedDeps } from '../../bootstrap/get-shared-deps.ts';
import { InkSink } from '../../../integration/logging/ink-sink.ts';
import { InkPromptAdapter } from '../../../integration/ui/prompts/prompt-adapter.ts';
import { registerExternalHost } from '../../../integration/ui/prompts/auto-mount.tsx';
import { App } from '../views/app.tsx';
import { enterAltScreen, exitAltScreen } from './screen.ts';
import { logEventBus } from './event-bus.ts';
import { isFirstLaunch } from '../../runtime/first-launch.ts';
import type { SharedDeps } from '../../bootstrap/shared-deps.ts';
import type { ViewId, ViewEntry } from '../views/router-context.ts';

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

  enterAltScreen();
  const releaseHost = registerExternalHost();

  const app = render(
    <App
      initialView={options.initialView}
      sessionManager={deps.sessionManager}
      sessionId={options.sessionId}
      initialStack={initialStack}
    />,
    { exitOnCtrlC: false }
  );

  try {
    await app.waitUntilExit();
  } finally {
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
