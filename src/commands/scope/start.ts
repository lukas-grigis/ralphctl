import { error, muted, warning } from '@src/utils/colors.ts';
import { runScope, type RunnerOptions } from '@src/services/runner.ts';
import { ScopeStatusError, ScopeNotFoundError } from '@src/services/scope.ts';

function parseArgs(args: string[]): { scopeId?: string; options: RunnerOptions } {
  const options: RunnerOptions = {
    interactive: false,
    count: null,
  };
  let scopeId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '-i' || arg === '--interactive') {
      options.interactive = true;
    } else if (arg === '-n' || arg === '--count') {
      const countStr = args[++i];
      if (!countStr) {
        throw new Error('--count requires a number');
      }
      const count = parseInt(countStr, 10);
      if (isNaN(count) || count < 1) {
        throw new Error('--count must be a positive integer');
      }
      options.count = count;
    } else if (!arg?.startsWith('-')) {
      scopeId = arg;
    }
  }

  return { scopeId, options };
}

export async function scopeStartCommand(args: string[]): Promise<void> {
  let scopeId: string | undefined;
  let options: RunnerOptions;

  try {
    const parsed = parseArgs(args);
    scopeId = parsed.scopeId;
    options = parsed.options;
  } catch (err) {
    if (err instanceof Error) {
      console.log(error(`\n${err.message}\n`));
    }
    return;
  }

  try {
    await runScope(scopeId, options);
  } catch (err) {
    if (err instanceof ScopeNotFoundError) {
      console.log(error(`\nScope not found: ${scopeId ?? 'unknown'}\n`));
    } else if (err instanceof ScopeStatusError) {
      console.log(error(`\n${err.message}`));
      console.log(muted('Activate the scope first: ralphctl scope activate <id>\n'));
    } else if (err instanceof Error && err.message.includes('No scope specified')) {
      console.log(warning('\nNo scope specified and no active scope set.'));
      console.log(muted('Specify a scope ID or activate one first.\n'));
    } else {
      throw err;
    }
  }
}
