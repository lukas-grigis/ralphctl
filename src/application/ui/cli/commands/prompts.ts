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

/**
 * Load every bundled prompt asset through the wired `TemplateLoader` and print one line each.
 * The listing is the point but the LOAD is the gate: an empty body or a missing file is a failed
 * install, so both fail the command rather than printing a zero-byte row.
 */
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
    loaded.push({ ...entry, bytes: body.value.length });
  }

  for (const entry of loaded.sort((a, b) => a.name.localeCompare(b.name))) {
    process.stdout.write(`${formatPromptLine(entry)}\n`);
  }
};

/**
 * Register the `prompts` command group.
 *
 *   ralphctl prompts list
 *
 * Inspection surface for the bundled prompt templates — and, deliberately, the only
 * non-interactive command that exercises the prompt-template resolver end to end. Prompts are the
 * largest bundled asset class and every AI flow depends on them, but their resolver
 * (`fs-template-loader.ts`) is a separate copy of the beside-the-module probe from the ones
 * `skills list` / `agents list` / `bundle-integrity` walk, and it falls back silently. Without a
 * command that reads a template back out of the built bundle, the CI + release dist smokes stay
 * green on an install whose prompts are all unreadable — the 0.15.0 failure class, scoped to
 * prompts. The workflows grep this command's output for exactly that reason.
 */
export const registerPromptsCommand = (program: Command): void => {
  const prompts = program.command('prompts').description('inspect the bundled prompt templates');

  prompts
    .command('list')
    .description('load every bundled prompt template + partial and list its name, kind and size')
    .action(listPromptsAction);
};
