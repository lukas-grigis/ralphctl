import type { Command } from 'commander';
import { bootstrapCli } from '@src/application/ui/cli/bootstrap.ts';
import { fail } from '@src/application/ui/cli/report-cli-error.ts';
import {
  BUNDLED_PROMPT_PARTIALS,
  BUNDLED_PROMPT_TEMPLATES,
} from '@src/integration/ai/prompts/_engine/bundled-templates.ts';

type PromptKind = 'template' | 'partial';

interface LoadedPrompt {
  readonly name: string;
  readonly kind: PromptKind;
  readonly bytes: number;
}

const formatPromptLine = (loaded: LoadedPrompt): string =>
  `${loaded.name.padEnd(26)}  ${loaded.kind.padEnd(8)}  ${String(loaded.bytes).padStart(6)} bytes`;

/** Load every bundled prompt asset through the wired `TemplateLoader` and print one line each. */
const listPromptsAction = async (): Promise<void> => {
  const { deps } = await bootstrapCli();

  const requested: readonly LoadedPrompt[] = [
    ...BUNDLED_PROMPT_TEMPLATES.map((name) => ({ name, kind: 'template' as const, bytes: 0 })),
    ...BUNDLED_PROMPT_PARTIALS.map((name) => ({ name, kind: 'partial' as const, bytes: 0 })),
  ];

  const loaded: LoadedPrompt[] = [];
  for (const entry of requested) {
    const body = await deps.templateLoader.load(entry.name);
    if (!body.ok) {
      fail(body.error.message);
      return;
    }
    if (body.value.trim().length === 0) {
      fail(`prompt template '${entry.name}' resolved to an empty file — the install is incomplete`);
      return;
    }
    loaded.push({ ...entry, bytes: Buffer.byteLength(body.value, 'utf8') });
  }

  for (const entry of loaded.sort((a, b) => a.name.localeCompare(b.name))) {
    process.stdout.write(`${formatPromptLine(entry)}\n`);
  }
};

/**
 * Register the `prompts` command group (`ralphctl prompts list`). It is deliberately the only non-interactive command
 * that reads a template back out of the built bundle, so the dist smokes catch an install whose prompts are unreadable.
 */
export const registerPromptsCommand = (program: Command): void => {
  const prompts = program.command('prompts').description('inspect the bundled prompt templates');

  prompts
    .command('list')
    .description('load every bundled prompt template + partial and list its name, kind and size')
    .action(listPromptsAction);
};
