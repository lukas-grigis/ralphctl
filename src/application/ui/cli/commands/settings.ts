import type { Command } from 'commander';
import { applySettingsKey } from '@src/business/settings/apply-key.ts';
import { isPresetName, PRESET_NAMES } from '@src/business/settings/presets.ts';
import { createSettingsShowFlow } from '@src/application/flows/settings-show/flow.ts';
import { createSettingsSetFlow } from '@src/application/flows/settings-set/flow.ts';
import { createSettingsSetProviderFlow } from '@src/application/flows/settings-set-provider/flow.ts';
import { createSettingsApplyPresetFlow } from '@src/application/flows/settings-apply-preset/flow.ts';
import { bootstrapCli } from '@src/application/ui/cli/bootstrap.ts';
import { fail } from '@src/application/ui/cli/report-cli-error.ts';
import type { AiImplementRole } from '@src/domain/entity/settings.ts';
import { AI_PROVIDERS, isAiProvider } from '@src/domain/entity/settings.ts';
import { PROVIDER_BINARY } from '@src/integration/system/detect-cli.ts';
import type { FlowId } from '@src/domain/value/flow-id.ts';
import type { SettingsRepository } from '@src/domain/repository/settings/settings-repository.ts';

/**
 * Detect a provider-setting key and return the parsed flow+role tuple. Returns `undefined` for any other key;
 * `applySettingsKey` (the legacy path) still handles those.
 */
const parseProviderKey = (key: string): { readonly flow: FlowId; readonly role?: AiImplementRole } | undefined => {
  const implementMatch = /^ai\.implement\.(generator|evaluator)\.provider$/.exec(key);
  if (implementMatch !== null) return { flow: 'implement', role: implementMatch[1] as AiImplementRole };
  const flatMatch = /^ai\.(refine|plan|readiness|ideate|createPr)\.provider$/.exec(key);
  if (flatMatch !== null) return { flow: flatMatch[1] as FlowId };
  return undefined;
};

const showSettingsAction = async (): Promise<void> => {
  const { deps } = await bootstrapCli();
  const flow = createSettingsShowFlow({ settingsRepo: deps.settingsRepo });
  const result = await flow.execute({ input: undefined });
  if (!result.ok) {
    fail(result.error.error.message);
    return;
  }
  process.stdout.write(`${JSON.stringify(result.value.ctx.output, null, 2)}\n`);
};

/**
 * Provider keys route through the dedicated `settings-set-provider` flow rather than the generic apply-key path.
 */
const setProviderKeyAction = async (
  key: string,
  value: string,
  role: AiImplementRole | undefined,
  flowId: FlowId,
  settingsRepo: SettingsRepository
): Promise<void> => {
  if (!isAiProvider(value)) {
    fail(`'${value}' is not a recognised provider (expected one of: ${AI_PROVIDERS.join(', ')})`);
    return;
  }
  const providerFlow = createSettingsSetProviderFlow({ settingsRepo });
  const saved = await providerFlow.execute({
    input: {
      flow: flowId,
      provider: value,
      ...(role !== undefined ? { role } : {}),
    },
  });
  if (!saved.ok) {
    const err = saved.error.error;
    const hint = 'hint' in err && typeof err.hint === 'string' ? ` (${err.hint})` : '';
    fail(`${err.message}${hint}`);
    return;
  }
  process.stdout.write(`${key} = ${value}\n`);
};

const setSettingsAction = async (key: string, value: string): Promise<void> => {
  const { deps } = await bootstrapCli();
  const providerKey = parseProviderKey(key);
  if (providerKey !== undefined) {
    await setProviderKeyAction(key, value, providerKey.role, providerKey.flow, deps.settingsRepo);
    return;
  }
  const showFlow = createSettingsShowFlow({ settingsRepo: deps.settingsRepo });
  const current = await showFlow.execute({ input: undefined });
  if (!current.ok) {
    fail(current.error.error.message);
    return;
  }
  const next = applySettingsKey(current.value.ctx.output!, key, value);
  if (!next.ok) {
    fail(next.error.message);
    return;
  }
  const setFlow = createSettingsSetFlow({ settingsRepo: deps.settingsRepo });
  const saved = await setFlow.execute({ input: { next: next.value } });
  if (!saved.ok) {
    fail(saved.error.error.message);
    return;
  }
  process.stdout.write(`${key} = ${value}\n`);
};

const applyPresetAction = async (name: string): Promise<void> => {
  if (!isPresetName(name)) {
    fail(`unknown preset '${name}' — expected one of: ${PRESET_NAMES.join(', ')}`);
    return;
  }
  const { deps } = await bootstrapCli();
  const flow = createSettingsApplyPresetFlow({ settingsRepo: deps.settingsRepo });
  const result = await flow.execute({ input: { preset: name } });
  if (!result.ok) {
    fail(result.error.error.message);
    return;
  }
  const output = result.value.ctx.output!;
  // Warnings are advisory — settings were stamped, so exit code stays 0.
  for (const w of output.warnings) {
    process.stderr.write(
      `warning: ${PROVIDER_BINARY[w.provider]} CLI not found on PATH; affects flows: ${w.flows.join(', ')}\n`
    );
  }
  process.stdout.write(`applied preset ${name}\n`);
};

/**
 * Register the `settings` command group (`ralphctl settings show` / `set <key> <value>`). `show` prints the current
 * settings as JSON; `set` goes through the shared `applySettingsKey` mutator, so the TUI and CLI accept the same keys.
 */
export const registerSettingsCommand = (program: Command): void => {
  const settings = program.command('settings').description('inspect and mutate ralphctl settings');

  settings.command('show').description('print the current settings as JSON').action(showSettingsAction);

  settings
    .command('set <key> <value>')
    .description('mutate one setting and persist (read-modify-write, schema-validated)')
    .action(setSettingsAction);

  settings
    .command('apply-preset <name>')
    .description(`stamp a preset onto ai.* (one of: ${PRESET_NAMES.join(', ')})`)
    .action(applyPresetAction);
};
