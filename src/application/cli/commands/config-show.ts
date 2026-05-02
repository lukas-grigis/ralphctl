/**
 * `config show` — print the persisted config plus any defaults.
 */
import type { Command } from 'commander';
import * as c from 'colorette';

import type { Result } from '@src/domain/result.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import type { Config } from '@src/application/config/config.ts';
import { runCommand } from '@src/application/cli/command-runner.ts';
import { EXIT_SUCCESS, type ExitCode } from '@src/application/cli/exit-codes.ts';

export function attachConfigShow(group: Command, deps: SharedDeps): void {
  group
    .command('show')
    .description('display the current configuration')
    .action(async () => {
      const code = await runConfigShow(deps);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

export async function runConfigShow(deps: SharedDeps): Promise<ExitCode> {
  return runCommand({
    deps,
    body: async () => deps.configStore.load() as ReturnType<() => Promise<Result<Config, never>>>,
    format: (_d, config) => formatConfig(config),
  });
}

function formatConfig(config: Config): string {
  const rows: [string, string][] = [
    ['currentSprint', config.currentSprint ?? c.dim('(none)')],
    ['aiProvider', config.aiProvider ?? c.dim('(unset)')],
    ['editor', config.editor ?? c.dim('(default)')],
    ['evaluationIterations', String(config.evaluationIterations)],
    ['logLevel', config.logLevel],
  ];
  const lines: string[] = [c.bold('Configuration')];
  for (const [k, v] of rows) {
    lines.push(`  ${c.dim(k.padEnd(22))} ${v}`);
  }
  return lines.join('\n');
}
