/**
 * `mountInkApp(options)` — entry point for the Ink-based TUI.
 *
 * Detects whether the current environment supports Ink (interactive TTY +
 * not CI/piped). When supported, mounts the Ink React tree with the right
 * initial view, wires `InkPromptAdapter` + `InMemorySignalBus` + `InkSink`
 * into SharedDeps, and awaits `waitUntilExit()` before returning.
 *
 * In non-TTY environments returns `{ fallback: true }` so the caller can
 * run the same logic with the PlainTextSink logger and no interactive
 * prompts (CI mode).
 *
 * The actual React views — `<HomeView />`, `<ExecuteView />` — are
 * implemented in Step 8. This module just hosts the plumbing.
 */

import React from 'react';
import { render } from 'ink';
import { createSharedDeps } from '@src/application/shared.ts';
import { setSharedDeps } from '@src/application/bootstrap.ts';
import { InkSink } from '@src/integration/logging/ink-sink.ts';
import { InMemorySignalBus } from '@src/integration/signals/bus.ts';
import { InkPromptAdapter } from '@src/integration/prompts/prompt-adapter.ts';
import { registerExternalHost } from '@src/integration/prompts/auto-mount.tsx';
import { App } from '@src/integration/ui/tui/views/app.tsx';
import { enterAltScreen, exitAltScreen } from './screen.ts';
import { registerTuiInstance } from './suspend.ts';
import type { ExecutionOptions } from '@src/domain/context.ts';

export type InkViewName = 'repl' | 'execute';

export interface MountOptions {
  initialView: InkViewName;
  /** For the 'execute' view: which sprint to execute. */
  sprintId?: string;
  /** For the 'execute' view: execution options. */
  executionOptions?: ExecutionOptions;
}

export interface MountResult {
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

export async function mountInkApp(options: MountOptions): Promise<MountResult> {
  if (!canMountInk()) {
    return { fallback: true };
  }

  const signalBus = new InMemorySignalBus();
  const logger = new InkSink();
  const prompt = new InkPromptAdapter();

  // Swap in the Ink-specific ports. Anything the REPL spawns — commands,
  // use cases, AI sessions — picks these up via `getSharedDeps()`.
  setSharedDeps(createSharedDeps({ logger, signalBus, prompt }));

  enterAltScreen();
  const releaseHost = registerExternalHost();
  const app = render(<App initialView={options.initialView} mountOptions={options} />, {
    exitOnCtrlC: false, // We own Ctrl+C inside the app for prompt cancellation.
  });
  // Make the render instance reachable from `withSuspendedTui` so interactive
  // AI sessions can step aside and force a repaint on return.
  const releaseInstance = registerTuiInstance(app);

  try {
    await app.waitUntilExit();
  } finally {
    releaseInstance();
    releaseHost();
    signalBus.dispose();
    exitAltScreen();
  }

  return { fallback: false };
}
