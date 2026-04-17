import type { PromptPort } from '@src/business/ports/prompt.ts';
import type { SharedDeps } from '@src/integration/shared-deps.ts';

let _shared: SharedDeps | null = null;

/**
 * Return the cached shared dependencies.
 *
 * The application entrypoint calls {@link setSharedDeps} at startup (with a
 * graph built by `createSharedDeps`), and the Ink mount path swaps in Ink
 * variants via the same setter. Integration never imports application at
 * runtime — `SharedDeps` is pulled in here as a type only so the composition
 * root stays the one module that knows how to construct the graph.
 *
 * @throws Error if accessed before the entrypoint initialised the graph.
 */
export function getSharedDeps(): SharedDeps {
  if (!_shared) {
    throw new Error(
      'SharedDeps not initialised — the application entrypoint must call setSharedDeps() before any CLI command runs.'
    );
  }
  return _shared;
}

/**
 * Replace the cached SharedDeps. Called by the application entrypoint at
 * startup and by the Ink mount path to swap in InkPromptAdapter + InkSink +
 * InMemorySignalBus before any command runs. Global state — only the app
 * entry (or the Ink mount path) should call it.
 */
export function setSharedDeps(deps: SharedDeps): void {
  _shared = deps;
}

/** Convenience accessor for the primitive prompt port. */
export function getPrompt(): PromptPort {
  return getSharedDeps().prompt;
}
