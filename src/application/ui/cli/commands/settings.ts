import type { Command } from 'commander';
import { applySettingsKey } from '@src/business/settings/apply-key.ts';
import { createSettingsShowFlow } from '@src/application/flows/settings-show/flow.ts';
import { createSettingsSetFlow } from '@src/application/flows/settings-set/flow.ts';
import { createSettingsSetProviderFlow } from '@src/application/flows/settings-set-provider/flow.ts';
import { bootstrapCli } from '@src/application/ui/cli/bootstrap.ts';
import type { AiProvider } from '@src/domain/entity/settings.ts';

const AI_PROVIDERS: readonly AiProvider[] = ['claude-code', 'github-copilot', 'openai-codex'];
const isAiProvider = (value: string): value is AiProvider => (AI_PROVIDERS as readonly string[]).includes(value);

/**
 * Register the `settings` command group.
 *
 *   ralphctl settings show
 *   ralphctl settings set <key> <value>
 *
 * `show` prints the current settings as JSON. `set` performs a read-modify-write through the
 * shared `applySettingsKey` mutator (also consumed by the TUI), so the supported key vocabulary
 * is one truth across both surfaces. Schema validation runs at the persistence boundary.
 *
 * Supported keys:
 *   ai.models.refine | plan | implement | readiness | ideate    provider-specific model id
 *   harness.maxTurns | maxAttempts | rateLimitRetries    integer (range-checked)
 *   logging.level                  silent | debug | info | warn | error
 *   concurrency.maxParallelTasks   positive integer
 */
export const registerSettingsCommand = (program: Command): void => {
  const settings = program.command('settings').description('inspect and mutate ralphctl settings');

  settings
    .command('show')
    .description('print the current settings as JSON')
    .action(async () => {
      const { deps } = await bootstrapCli();
      const flow = createSettingsShowFlow({ settingsRepo: deps.settingsRepo });
      const result = await flow.execute({ input: undefined });
      if (!result.ok) {
        process.stderr.write(`error: ${result.error.error.message}\n`);
        process.exit(1);
        return;
      }
      process.stdout.write(`${JSON.stringify(result.value.ctx.output, null, 2)}\n`);
    });

  settings
    .command('set <key> <value>')
    .description('mutate one setting and persist (read-modify-write, schema-validated)')
    .action(async (key: string, value: string) => {
      const { deps } = await bootstrapCli();
      // Provider switches route through the coordinated use-case so the four chain models reset
      // to that provider's defaults. `applySettingsKey` still rejects `ai.provider` for any
      // other caller — that rejection is the safety net.
      if (key === 'ai.provider') {
        if (!isAiProvider(value)) {
          process.stderr.write(
            `error: '${value}' is not a recognised provider (expected one of: ${AI_PROVIDERS.join(', ')})\n`
          );
          process.exit(1);
          return;
        }
        const providerFlow = createSettingsSetProviderFlow({ settingsRepo: deps.settingsRepo });
        const saved = await providerFlow.execute({ input: { provider: value } });
        if (!saved.ok) {
          process.stderr.write(`error: ${saved.error.error.message}\n`);
          process.exit(1);
          return;
        }
        process.stdout.write(`${key} = ${value} (models reset to ${value} defaults)\n`);
        return;
      }
      const showFlow = createSettingsShowFlow({ settingsRepo: deps.settingsRepo });
      const current = await showFlow.execute({ input: undefined });
      if (!current.ok) {
        process.stderr.write(`error: ${current.error.error.message}\n`);
        process.exit(1);
        return;
      }
      const next = applySettingsKey(current.value.ctx.output!, key, value);
      if (!next.ok) {
        process.stderr.write(`error: ${next.error.message}\n`);
        process.exit(1);
        return;
      }
      const setFlow = createSettingsSetFlow({ settingsRepo: deps.settingsRepo });
      const saved = await setFlow.execute({ input: { next: next.value } });
      if (!saved.ok) {
        process.stderr.write(`error: ${saved.error.error.message}\n`);
        process.exit(1);
        return;
      }
      process.stdout.write(`${key} = ${value}\n`);
    });
};
