/**
 * `config set <key> <value>` — persist a single config field.
 *
 * Validates `key` against the {@link Config} shape and `value` against the
 * field type before writing. Unknown keys / malformed values fail with
 * `EXIT_ERROR` and a hint listing valid keys.
 */
import type { Command } from 'commander';
import * as c from 'colorette';

import { ValidationError } from '@src/domain/values/validation-error.ts';
import { Result } from '@src/domain/result.ts';
import { SprintId } from '@src/domain/values/sprint-id.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import type { AiProvider, Config } from '@src/application/config/config.ts';
import { runCommand } from '@src/application/cli/command-runner.ts';
import { EXIT_SUCCESS, type ExitCode } from '@src/application/cli/exit-codes.ts';
import type { LogFilterLevel } from '@src/business/ports/logger-port.ts';

const VALID_KEYS = ['currentSprint', 'aiProvider', 'editor', 'evaluationIterations', 'logLevel'] as const;

type ConfigKey = (typeof VALID_KEYS)[number];

export function attachConfigSet(group: Command, deps: SharedDeps): void {
  group
    .command('set <key> <value>')
    .description(`set a config field. Valid keys: ${VALID_KEYS.join(', ')}`)
    .action(async (key: string, value: string) => {
      const code = await runConfigSet(deps, key, value);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

export async function runConfigSet(deps: SharedDeps, key: string, value: string): Promise<ExitCode> {
  return runCommand({
    deps,
    body: async () => {
      if (!isValidKey(key)) {
        return Result.error(
          new ValidationError({
            field: 'config-key',
            value: key,
            message: `unknown config key '${key}'`,
            hint: `valid keys: ${VALID_KEYS.join(', ')}`,
          })
        );
      }
      const loaded = await deps.configStore.load();
      if (!loaded.ok) return Result.error(loaded.error);
      const updated = applyKey(loaded.value, key, value);
      if (!updated.ok) return Result.error(updated.error);
      const saved = await deps.configStore.save(updated.value);
      if (!saved.ok) return Result.error(saved.error);
      return Result.ok(updated.value);
    },
    format: (_d, config) => `${c.green('saved')} ${c.bold(key)} = ${formatValue(key as ConfigKey, config)}`,
  });
}

function isValidKey(k: string): k is ConfigKey {
  return (VALID_KEYS as readonly string[]).includes(k);
}

function applyKey(config: Config, key: ConfigKey, raw: string): Result<Config, ValidationError> {
  switch (key) {
    case 'currentSprint': {
      if (raw === '' || raw === 'null') return Result.ok({ ...config, currentSprint: null });
      const parsed = SprintId.parse(raw);
      if (!parsed.ok) return Result.error(parsed.error);
      return Result.ok({ ...config, currentSprint: parsed.value });
    }
    case 'aiProvider': {
      if (raw === 'null' || raw === '') return Result.ok({ ...config, aiProvider: null });
      if (raw !== 'claude' && raw !== 'copilot') {
        return Result.error(
          new ValidationError({
            field: 'aiProvider',
            value: raw,
            message: "aiProvider must be 'claude' or 'copilot'",
          })
        );
      }
      const provider: AiProvider = raw;
      return Result.ok({ ...config, aiProvider: provider });
    }
    case 'editor': {
      if (raw === '' || raw === 'null') return Result.ok({ ...config, editor: null });
      return Result.ok({ ...config, editor: raw });
    }
    case 'evaluationIterations': {
      const n = Number.parseInt(raw, 10);
      if (!Number.isInteger(n) || n < 0) {
        return Result.error(
          new ValidationError({
            field: 'evaluationIterations',
            value: raw,
            message: 'evaluationIterations must be a non-negative integer',
          })
        );
      }
      return Result.ok({ ...config, evaluationIterations: n });
    }
    case 'logLevel': {
      const valid: readonly LogFilterLevel[] = ['debug', 'info', 'warn', 'error'];
      if (!(valid as readonly string[]).includes(raw)) {
        return Result.error(
          new ValidationError({
            field: 'logLevel',
            value: raw,
            message: `logLevel must be one of: ${valid.join(', ')}`,
          })
        );
      }
      return Result.ok({ ...config, logLevel: raw as LogFilterLevel });
    }
  }
}

function formatValue(key: ConfigKey, config: Config): string {
  switch (key) {
    case 'currentSprint':
      return config.currentSprint ?? c.dim('null');
    case 'aiProvider':
      return config.aiProvider ?? c.dim('null');
    case 'editor':
      return config.editor ?? c.dim('null');
    case 'evaluationIterations':
      return String(config.evaluationIterations);
    case 'logLevel':
      return config.logLevel;
  }
}
