/**
 * `promptOrPop` — wrap a prompt call with the standard cancel handling.
 *
 * Today, ~57 CRUD form views in `tui/views/crud/` repeat the same pattern:
 *
 * ```ts
 * try {
 *   value = await prompt.input({ ... });
 * } catch (err) {
 *   if (err instanceof PromptCancelledError) {
 *     router.pop();
 *     throw err;
 *   }
 *   throw err;
 * }
 * ```
 *
 * This helper collapses that boilerplate into one call. On Ctrl+C / Esc the
 * prompt throws `PromptCancelledError`; we pop the view (so the user lands
 * back wherever they came from) and re-throw so the surrounding
 * `useWorkflow` turns it into a `cancelled` terminal state. Any other error
 * propagates unchanged.
 *
 * Migration of all call sites is a follow-up — this file just lands the
 * seam so the next PR can sweep them in mechanically.
 */
import type { RouterApi } from '@src/application/tui/views/router-context.ts';
import { PromptCancelledError } from '@src/business/ports/prompt-port.ts';

export async function promptOrPop<T>(router: Pick<RouterApi, 'pop'>, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof PromptCancelledError) {
      router.pop();
    }
    throw err;
  }
}
