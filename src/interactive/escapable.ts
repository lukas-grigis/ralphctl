import readline from 'node:readline';
import { select } from '@inquirer/prompts';
import { bold, dim } from 'colorette';

type SelectConfig<Value> = Parameters<typeof select<Value>>[0];

/**
 * Default keysHelpTip renderer matching @inquirer/select's built-in format.
 * Used as fallback when the caller doesn't provide a custom keysHelpTip.
 */
function defaultKeysHelpTip(keys: [string, string][]): string {
  return keys.map(([key, action]) => `${bold(key)} ${dim(action)}`).join(dim(' \u2022 '));
}

/**
 * Augment a select config's theme to append an "esc back" hint to the key help line.
 */
type KeysHelpTip = (keys: [string, string][]) => string | undefined;

function withEscapeHint<Value>(config: SelectConfig<Value>): SelectConfig<Value> {
  const originalTip = config.theme?.style?.keysHelpTip as KeysHelpTip | undefined;

  return {
    ...config,
    theme: {
      ...config.theme,
      style: {
        ...config.theme?.style,
        keysHelpTip: (keys: [string, string][]) => {
          const allKeys: [string, string][] = [...keys, ['esc', 'back']];
          return originalTip ? originalTip(allKeys) : defaultKeysHelpTip(allKeys);
        },
      },
    },
  };
}

/**
 * Escape-aware wrapper around @inquirer/prompts select().
 *
 * Listens for the Escape key and aborts the prompt, returning null.
 * Ctrl+C (ExitPromptError) propagates unchanged so callers can handle it.
 * Appends an "esc back" hint to the bottom help line.
 *
 * Uses duck-typing for AbortPromptError to avoid depending on @inquirer/core directly.
 *
 * @returns the selected value, or null if the user pressed Escape
 */
export async function escapableSelect<Value>(config: SelectConfig<Value>): Promise<Value | null> {
  const controller = new AbortController();

  // Ensure stdin emits 'keypress' events (idempotent — safe to call multiple times)
  readline.emitKeypressEvents(process.stdin);

  const onKeypress = (_ch: string, key: { name: string } | undefined) => {
    if (key?.name === 'escape') {
      controller.abort();
    }
  };

  process.stdin.on('keypress', onKeypress);

  try {
    const result = await select(withEscapeHint(config), { signal: controller.signal });
    return result;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortPromptError') {
      return null;
    }
    throw err;
  } finally {
    process.stdin.removeListener('keypress', onKeypress);
  }
}
