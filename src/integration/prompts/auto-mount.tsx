/**
 * Auto-mounting helper for the Ink prompt layer.
 *
 * The prompt adapter is the single source of truth for interactive prompts —
 * whether the full Ink dashboard is mounted or we're in a one-shot CLI command
 * (`ralphctl project add`, `ralphctl sprint create`, etc). When a prompt fires
 * and no host is active, this module spins up a minimal Ink tree containing
 * only `<PromptHost />`, drains the queue, and unmounts.
 *
 * Non-TTY / CI / piped environments cannot host Ink and therefore cannot
 * prompt — callers should pass the answer as a flag. Attempting to prompt in
 * that mode throws `PromptCancelledError` with a helpful message.
 */

import React from 'react';
import { render, type Instance } from 'ink';
import { PromptCancelledError } from '@src/business/ports/prompt.ts';
import { PromptHost } from './prompt-host.tsx';
import { promptQueue } from './prompt-queue.ts';

type HostState = 'external' | 'auto' | 'none';

let hostState: HostState = 'none';
let autoInstance: Instance | null = null;
let drainUnsubscribe: (() => void) | null = null;

/**
 * Called by `mountInkApp()` when the full dashboard takes over. Tells the
 * prompt layer that `<PromptHost />` is already in the tree and auto-mount
 * is not needed.
 */
export function registerExternalHost(): () => void {
  hostState = 'external';
  return () => {
    hostState = 'none';
  };
}

export function canInteract(): boolean {
  if (process.env['RALPHCTL_NO_TUI']) return false;
  if (process.env['CI']) return false;
  if (process.env['RALPHCTL_JSON']) return false;
  if (!process.stdout.isTTY) return false;
  if (!process.stdin.isTTY) return false;
  return true;
}

/**
 * Ensure something is rendering `<PromptHost />`. No-op if an external host
 * (the full Ink dashboard) is already active. Otherwise mounts a minimal Ink
 * tree containing only the prompt host and arranges to unmount when the
 * queue drains.
 *
 * Throws `PromptCancelledError` in non-interactive environments.
 */
export function ensurePromptHost(): void {
  if (hostState === 'external' || hostState === 'auto') return;

  if (!canInteract()) {
    throw new PromptCancelledError(
      'Interactive prompt requested in non-interactive environment. Pass the value as a CLI flag.'
    );
  }

  hostState = 'auto';
  autoInstance = render(<PromptHost />, { exitOnCtrlC: false });

  // Unmount as soon as the queue is empty — keeps one-shot prompt flows from
  // holding the process open after the answer lands.
  drainUnsubscribe = promptQueue.subscribe((current) => {
    if (current === null) {
      // Defer the unmount so React has a chance to flush the resolved state.
      setImmediate(() => {
        if (promptQueue.size() === 0) teardownAutoHost();
      });
    }
  });
}

function teardownAutoHost(): void {
  if (hostState !== 'auto') return;
  drainUnsubscribe?.();
  drainUnsubscribe = null;
  autoInstance?.unmount();
  autoInstance = null;
  hostState = 'none';
}
