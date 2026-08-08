import type { Command } from 'commander';
import { applySettingsKey } from '@src/business/settings/apply-key.ts';
import { isPresetName, PRESET_NAMES } from '@src/business/settings/presets.ts';
import { createSettingsShowFlow } from '@src/application/flows/settings-show/flow.ts';
import { createSettingsSetFlow } from '@src/application/flows/settings-set/flow.ts';
import { createSettingsSetProviderFlow } from '@src/application/flows/settings-set-provider/flow.ts';
import { createSettingsApplyPresetFlow } from '@src/application/flows/settings-apply-preset/flow.ts';
import { bootstrapCli } from '@src/application/ui/cli/bootstrap.ts';
import { fail } from '@src/application/ui/cli/report-cli-error.ts';
import type { AiImplementRole, AiProvider } from '@src/domain/entity/settings.ts';
import { AI_PROVIDERS } from '@src/domain/entity/settings.ts';
import type { FlowId } from '@src/domain/value/flow-id.ts';
import type { SettingsRepository } from '@src/domain/repository/settings/settings-repository.ts';

const isAiProvider = (raw: string): raw is AiProvider => (AI_PROVIDERS as readonly string[]).includes(raw);

/**
 * Detect a provider-setting key and return the parsed flow+role tuple. Returns `undefined` for
 * any other key; `applySettingsKey` (the legacy path) still handles those. Recognised shapes:
 *   - `ai.<flow>.provider`              (flow ∈ refine | plan | readiness | ideate | createPr)
 *   - `ai.implement.<role>.provider`    (role ∈ generator | evaluator)
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
 * Provider keys route through the dedicated `settings-set-provider` flow rather than the
 * generic apply-key path. That flow rebuilds the row's `{ provider, model }` pair from the new
 * provider's defaults (so the schema stays satisfied) AND runs the same PATH-availability gate
 * as the launch-time fail-fast helper — so an `openai-codex` assignment fails here exactly as it
 * would on the next implement run. Unknown provider ids still surface as a ValidationError so
 * callers can distinguish "wrong shape" from "valid shape but CLI missing".
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
  // Warnings are advisory — settings were stamped, so exit code stays 0. The user can
  // still iterate (install the missing CLI, then re-run their flow) without re-applying
  // the preset.
  for (const w of output.warnings) {
    process.stderr.write(`warning: ${w.provider} CLI not found on PATH; affects flows: ${w.flows.join(', ')}\n`);
  }
  process.stdout.write(`applied preset ${name}\n`);
};

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
 *   ai.effort                                          low | medium | high | xhigh | max (global default)
 *   ai.{flow}.provider                                 claude-code | github-copilot | openai-codex
 *   ai.{flow}.model                                    provider-native enum, or any non-empty custom string
 *   ai.{flow}.effort                                   provider-native effort level
 *      flow in {refine, plan, readiness, ideate}
 *   ai.implement.{generator|evaluator}.{provider,model,effort}
 *                                                      implement splits into a generator + evaluator pair
 *   ai.implement.agents.{generator|evaluator}          bind an agent-definition name to that role (empty value clears it);
 *                                                      see `ralphctl agents list` for the available names — any other
 *                                                      role/flow target is reported as unsupported, not silently accepted
 *   harness.maxTurns | maxAttempts | rateLimitRetries | idleWatchdogMs | plateauThreshold    integer (range-checked)
 *   harness.escalateOnPlateau                          boolean (escalate generator model on plateau)
 *   harness.skipPreVerifyOnFreshSetup                  boolean (skip first pre-verify when this run's setup verified the tree)
 *   harness.escalationMap.<fromModel>                  upgraded model id; empty input clears the entry
 *   logging.level                                      silent | debug | info | warn | error
 *   concurrency.maxParallelTasks                       1–5 (1 = serial; >1 = parallel, one git worktree per task)
 *   ui.notifications.enabled                           boolean
 *
 * Note: `ai.provider` and `ai.models.<flow>` (v1 grammar) are rejected as unknown keys —
 * the per-flow rows superseded them. `ai.implement.<field>` (the v0.7.0 flat-row grammar) is
 * likewise rejected — use `ai.implement.generator.<field>` or `ai.implement.evaluator.<field>`.
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
