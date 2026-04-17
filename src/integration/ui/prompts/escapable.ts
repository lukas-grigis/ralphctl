import { getPrompt } from '@src/integration/bootstrap.ts';
import { PromptCancelledError } from '@src/business/ports/prompt.ts';

/**
 * Selectable menu item: maps to `PromptChoice` when passed to the PromptPort.
 */
interface EscapableChoice<Value> {
  name: string;
  value: Value;
  description?: string;
  disabled?: boolean | string;
}

/**
 * Purely visual divider. Rendered as a disabled entry so menu builders (see
 * `src/integration/ui/tui/views/menu-builder.ts`) can group related items.
 */
interface EscapableSeparator {
  separator: string;
}

type EscapableItem<Value> = EscapableChoice<Value> | EscapableSeparator;

interface EscapableSelectConfig<Value> {
  message: string;
  choices: EscapableItem<Value>[];
  default?: Value;
}

function isChoice<Value>(item: EscapableItem<Value>): item is EscapableChoice<Value> {
  return 'value' in item && 'name' in item;
}

/**
 * Escape-aware wrapper around `PromptPort.select()`.
 *
 * Returns `null` when the user cancels (Escape or Ctrl+C) via
 * `PromptCancelledError`. Unexpected errors propagate unchanged.
 *
 * @param config - select prompt config including choices and optional default
 * @returns the selected value, or null if the user cancelled
 */
export async function escapableSelect<Value>(config: EscapableSelectConfig<Value>): Promise<Value | null> {
  // PromptPort has no concept of non-selectable dividers; separators are
  // rendered as disabled entries to preserve the visual grouping.
  const choices = config.choices.map(
    (item): { label: string; value: Value; description?: string; disabled?: boolean | string } => {
      if (isChoice<Value>(item)) {
        return {
          label: item.name,
          value: item.value,
          description: item.description,
          disabled: item.disabled,
        };
      }
      return {
        label: item.separator,
        value: undefined as unknown as Value,
        disabled: true,
      };
    }
  );

  try {
    return await getPrompt().select<Value>({
      message: config.message,
      choices,
      default: config.default,
    });
  } catch (err) {
    if (err instanceof PromptCancelledError) return null;
    throw err;
  }
}
