import {
  getAiProvider,
  getConfig,
  getEditor,
  getEvaluationIterations,
  setAiProvider,
  setEditor,
  setEvaluationIterations,
} from '@src/integration/persistence/config.ts';
import { field, icons, log, printHeader, showError, showSuccess } from '@src/integration/ui/theme/ui.ts';
import {
  getAllConfigSchemaEntries,
  parseConfigValue,
  getConfigDefaultValue,
} from '@src/integration/config/schema-provider.ts';
import type { ConfigSchemaKeys } from '@src/domain/config-schema.ts';

/** Map user-facing key aliases to schema keys (e.g. "provider" → "aiProvider"). */
const KEY_ALIASES: Record<string, ConfigSchemaKeys> = {
  provider: 'aiProvider',
};

/** Resolve key alias or return as-is if not aliased. */
function resolveKeyAlias(key: string): string {
  return KEY_ALIASES[key] ?? key;
}

export async function configSetCommand(args: string[]): Promise<void> {
  if (args.length < 2) {
    showError('Usage: ralphctl config set <key> <value>');
    const keys = getAllConfigSchemaEntries()
      .filter((e) => e.key !== 'currentSprint') // Internal key, not user-facing
      .map((e) => e.key);
    log.dim(`Available keys: ${keys.join(', ')}, provider (alias for aiProvider)`);
    log.newline();
    return;
  }

  const [rawKey, value] = args;
  const key = resolveKeyAlias(rawKey ?? '');

  // Validate and parse via schema
  const result = parseConfigValue(key, value ?? '');
  if (!result.ok) {
    showError(result.error.message);
    log.newline();
    return;
  }

  // Persist via existing setter functions (preserves file-lock semantics)
  const parsedValue = result.value;
  switch (key) {
    case 'aiProvider':
      await setAiProvider(parsedValue as 'claude' | 'copilot');
      break;
    case 'editor':
      await setEditor(parsedValue as string);
      break;
    case 'evaluationIterations':
      await setEvaluationIterations(parsedValue as number);
      break;
    default:
      showError(`Config key '${key}' cannot be set directly`);
      log.newline();
      return;
  }

  showSuccess(`${key} set to: ${String(parsedValue)}`);
  log.newline();
}

export async function configShowCommand(): Promise<void> {
  const config = await getConfig();
  const provider = await getAiProvider();
  const editorCmd = await getEditor();
  const evalIterations = await getEvaluationIterations();

  // Build current values map for display
  const currentValues: Record<string, string | number | boolean | null | undefined> = {
    currentSprint: config.currentSprint,
    aiProvider: provider,
    editor: editorCmd,
    evaluationIterations: evalIterations,
  };

  printHeader('Configuration', icons.info);

  for (const entry of getAllConfigSchemaEntries()) {
    const current = currentValues[entry.key];
    const defaultVal = getConfigDefaultValue(entry.key as ConfigSchemaKeys);
    const isDefault = current === defaultVal;

    let displayValue: string;
    if (current === null || current === undefined) {
      displayValue = '(not set — will prompt on first use)';
    } else if (isDefault) {
      displayValue = `${String(current)} (default)`;
    } else if (current === 0 && entry.key === 'evaluationIterations') {
      displayValue = '0 (disabled)';
    } else {
      displayValue = String(current);
    }

    console.log(field(entry.key, displayValue));
    log.dim(`  ${entry.description}`);
  }

  log.newline();
}
