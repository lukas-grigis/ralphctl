/**
 * `runSelectConfirmRemove` — the shared "list → select → confirm → remove"
 * dance used by `sprint-remove`, `ticket-remove`, `task-remove`, and
 * `project-remove` views.
 *
 * The helper owns the three interactive steps:
 *   1. Show a `select` prompt over the supplied items.
 *   2. Show a `confirm` prompt with a per-item message.
 *   3. Call the supplied `remove(id)` use case.
 *
 * Cancellation flows through `promptOrPop`: Ctrl+C / Esc on either prompt
 * pops the view and rejects the workflow. Saying "no" to the confirm
 * also pops and rejects with a `Cancelled.` message — same shape every
 * remove view used before this helper.
 *
 * The caller passes:
 *  - `items` — already-loaded list (the helper does NOT do the list call;
 *    the variation in list APIs is too high to abstract here)
 *  - `itemLabel(item)` — what to show in the picker
 *  - `itemId(item)` — the picker value (string)
 *  - `confirmMessage(item)` — per-item confirmation copy
 *  - `remove(id)` — the actual use-case call
 *
 * Returns the selected item on success so the view can render its name in
 * the success card.
 */
import type { PromptPort } from '../../../business/ports/prompt-port.ts';
import { promptOrPop } from './prompt-or-pop.ts';
import type { RouterApi } from '../views/router-context.ts';

export interface SelectConfirmRemoveOpts<TItem> {
  readonly prompt: PromptPort;
  readonly router: Pick<RouterApi, 'pop'>;
  readonly items: readonly TItem[];
  readonly selectMessage: string;
  readonly itemLabel: (item: TItem) => string;
  readonly itemId: (item: TItem) => string;
  readonly confirmMessage: (item: TItem) => string;
  readonly remove: (id: string) => Promise<void>;
}

export async function runSelectConfirmRemove<TItem>(opts: SelectConfirmRemoveOpts<TItem>): Promise<TItem> {
  const { prompt, router, items, selectMessage, itemLabel, itemId, confirmMessage, remove } = opts;

  const selectedId = await promptOrPop(router, () =>
    prompt.select<string>({
      message: selectMessage,
      choices: items.map((item) => ({ label: itemLabel(item), value: itemId(item) })),
    })
  );

  const target = items.find((item) => itemId(item) === selectedId);
  if (target === undefined) throw new Error('Selected item not found.');

  const confirmed = await promptOrPop(router, () =>
    prompt.confirm({
      message: confirmMessage(target),
      default: false,
    })
  );
  if (!confirmed) {
    router.pop();
    throw new Error('Cancelled.');
  }

  await remove(selectedId);
  return target;
}
