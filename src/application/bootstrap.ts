import type { PromptPort } from '@src/business/ports/prompt.ts';
import { createSharedDeps, type SharedDeps } from './shared.ts';

let _shared: SharedDeps | null = null;

/** Lazily create and cache shared dependencies (called from CLI commands). */
export function getSharedDeps(): SharedDeps {
  _shared ??= createSharedDeps();
  return _shared;
}

/**
 * Replace the cached SharedDeps. Called by the Ink mount path to swap in
 * InkPromptAdapter + InkSink + InMemorySignalBus before any command runs.
 * Keep in mind this is global state — only the app entry should call it.
 */
export function setSharedDeps(deps: SharedDeps): void {
  _shared = deps;
}

/** Convenience accessor for the primitive prompt port. */
export function getPrompt(): PromptPort {
  return getSharedDeps().prompt;
}
