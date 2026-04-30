/**
 * `PromptPort` implementation backed by the Ink prompt queue.
 *
 * Every prompt call enqueues a `PendingPrompt` and returns a promise. A host
 * component (`<PromptHost />`) renders the head of the queue and resolves or
 * rejects the promise when the user acts. Parallel calls queue — only the
 * head prompt renders at a time.
 *
 * The host can come from two places:
 *   1. The full Ink dashboard — `mountInkApp()` already renders `<PromptHost />`
 *      and calls `registerExternalHost()`.
 *   2. A one-shot CLI command — the first prompt call auto-mounts a minimal
 *      Ink tree containing only `<PromptHost />` via `ensurePromptHost()`.
 *
 * Non-TTY / CI environments throw `PromptCancelledError` — pass values as flags.
 *
 * Ported from src/integration/ui/prompts/prompt-adapter.ts — no legacy src/ imports.
 */

import type {
  CheckboxOptions,
  ConfirmOptions,
  EditorOptions,
  FileBrowserOptions,
  InputOptions,
  PromptPort,
  SelectOptions,
} from '../../../business/ports/prompt-port.ts';
import { ensurePromptHost } from './auto-mount.tsx';
import { promptQueue } from './prompt-queue.ts';

export class InkPromptAdapter implements PromptPort {
  select<T>(options: SelectOptions<T>): Promise<T> {
    ensurePromptHost();
    return new Promise<T>((resolve, reject) => {
      promptQueue.enqueue({
        kind: 'select',
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        options: options as SelectOptions<unknown>,
        resolve: resolve as unknown as (v: unknown) => void,
        reject,
      });
    });
  }

  confirm(options: ConfirmOptions): Promise<boolean> {
    ensurePromptHost();
    return new Promise<boolean>((resolve, reject) => {
      promptQueue.enqueue({ kind: 'confirm', options, resolve, reject });
    });
  }

  input(options: InputOptions): Promise<string> {
    ensurePromptHost();
    return new Promise<string>((resolve, reject) => {
      promptQueue.enqueue({ kind: 'input', options, resolve, reject });
    });
  }

  checkbox<T>(options: CheckboxOptions<T>): Promise<T[]> {
    ensurePromptHost();
    return new Promise<T[]>((resolve, reject) => {
      promptQueue.enqueue({
        kind: 'checkbox',
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        options: options as CheckboxOptions<unknown>,
        resolve: resolve as unknown as (v: unknown[]) => void,
        reject,
      });
    });
  }

  editor(options: EditorOptions): Promise<string | null> {
    ensurePromptHost();
    return new Promise<string | null>((resolve, reject) => {
      promptQueue.enqueue({ kind: 'editor', options, resolve, reject });
    });
  }

  fileBrowser(options: FileBrowserOptions): Promise<string | null> {
    ensurePromptHost();
    return new Promise<string | null>((resolve, reject) => {
      promptQueue.enqueue({ kind: 'fileBrowser', options, resolve, reject });
    });
  }
}
