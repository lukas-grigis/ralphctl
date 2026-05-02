/**
 * `resolveCompletions` — Commander tree introspection for shell tab-completion.
 *
 * Walks the program tree to find the deepest matching command, then offers
 * either subcommands, options, dynamic value sources (project / sprint /
 * config keys / status enums), or nothing — depending on what the user is
 * typing right now.
 *
 * Dynamic value sources read fresh from the persistence repos via
 * `SharedDeps`; on any failure we degrade to an empty list so a broken
 * project store doesn't break the user's shell.
 */
import type { Command } from 'commander';
import type { CompletionItem } from 'tabtab';

import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';

export interface CompletionContext {
  /** The full line typed so far. */
  readonly line: string;
  /** The last word (what the user is currently typing). */
  readonly last: string;
  /** The word before the last word. */
  readonly prev: string;
}

type DynamicResolver = (deps: SharedDeps) => Promise<readonly CompletionItem[]>;

const STATUS_VALUES: readonly CompletionItem[] = [
  { name: 'draft', description: 'Draft sprints' },
  { name: 'active', description: 'Active sprints' },
  { name: 'closed', description: 'Closed sprints' },
  { name: 'todo', description: 'Todo tasks' },
  { name: 'in_progress', description: 'In-progress tasks' },
  { name: 'done', description: 'Done tasks' },
  { name: 'blocked', description: 'Blocked tasks' },
  { name: 'pending', description: 'Pending requirements' },
  { name: 'approved', description: 'Approved requirements' },
];

const CONFIG_KEY_COMPLETIONS: readonly CompletionItem[] = [
  { name: 'aiProvider', description: 'AI provider (claude or copilot)' },
  { name: 'evaluationIterations', description: 'Max evaluator rounds per task' },
  { name: 'logLevel', description: 'Log filter level' },
  { name: 'editor', description: 'Override editor for multi-line prompts' },
  // legacy alias accepted for back-compat
  { name: 'provider', description: 'Alias for aiProvider' },
];

const CONFIG_VALUE_COMPLETIONS: Readonly<Record<string, readonly CompletionItem[]>> = {
  aiProvider: [
    { name: 'claude', description: 'Claude Code CLI' },
    { name: 'copilot', description: 'GitHub Copilot CLI' },
  ],
  provider: [
    { name: 'claude', description: 'Claude Code CLI' },
    { name: 'copilot', description: 'GitHub Copilot CLI' },
  ],
  logLevel: [
    { name: 'debug', description: 'Everything' },
    { name: 'info', description: 'Default' },
    { name: 'warn', description: 'Warnings and errors only' },
    { name: 'error', description: 'Errors only' },
  ],
};

const dynamicResolvers: Readonly<Record<string, DynamicResolver>> = {
  '--project': async (deps: SharedDeps): Promise<readonly CompletionItem[]> => {
    const result = await deps.projectRepo.list();
    if (!result.ok) return [];
    return result.value.map((p) => ({
      name: String(p.name),
      description: p.displayName,
    }));
  },
  '--sprint': async (deps: SharedDeps): Promise<readonly CompletionItem[]> => {
    const result = await deps.sprintRepo.list();
    if (!result.ok) return [];
    return result.value.map((s) => ({
      name: String(s.id),
      description: `${s.name} (${s.status})`,
    }));
  },
  '--status': () => Promise.resolve(STATUS_VALUES),
  '--shell': () =>
    Promise.resolve([
      { name: 'bash', description: 'Bash' },
      { name: 'zsh', description: 'Zsh' },
      { name: 'fish', description: 'Fish' },
    ]),
};

function getSubcommands(cmd: Command): readonly CompletionItem[] {
  return cmd.commands.map((sub: Command) => ({
    name: sub.name(),
    description: sub.description(),
  }));
}

function getOptions(cmd: Command): readonly CompletionItem[] {
  const items: CompletionItem[] = [];
  for (const opt of cmd.options) {
    const flag = opt.long ?? opt.short;
    if (flag !== undefined && flag.length > 0) {
      items.push({ name: flag, description: opt.description });
    }
  }
  return items;
}

function findSubcommand(cmd: Command, name: string): Command | undefined {
  return cmd.commands.find((sub: Command) => sub.name() === name);
}

function optionExpectsValue(cmd: Command, flag: string): boolean {
  const opt = cmd.options.find((o) => o.long === flag || o.short === flag);
  if (!opt) return false;
  return opt.required || opt.optional;
}

function parseWords(line: string): readonly string[] {
  return line.trim().split(/\s+/).slice(1);
}

function getCommandPath(cmd: Command): string {
  const parts: string[] = [];
  let current: Command = cmd;
  // Commander types `parent` as `Command | null` — root command has parent === null.
  while (current.parent !== null) {
    parts.unshift(current.name());
    current = current.parent;
  }
  return parts.join(' ');
}

function acceptsPositionalArg(cmd: Command): boolean {
  return cmd.registeredArguments.length > 0;
}

async function getSprintCompletions(deps: SharedDeps): Promise<readonly CompletionItem[]> {
  const result = await deps.sprintRepo.list();
  if (!result.ok) return [];
  return result.value.map((s) => ({
    name: String(s.id),
    description: `${s.name} (${s.status})`,
  }));
}

/**
 * Walk the command tree starting from `program` to find the deepest
 * subcommand the user has already typed. Skips flags and their values.
 */
function resolveCurrentCommand(program: Command, words: readonly string[]): Command {
  let current: Command = program;
  let i = 0;
  while (i < words.length) {
    const word = words[i];
    if (word === undefined) break;
    if (word.startsWith('-')) {
      i++;
      if (optionExpectsValue(current, word) && i < words.length) {
        i++;
      }
      continue;
    }
    const sub = findSubcommand(current, word);
    if (!sub) break;
    current = sub;
    i++;
  }
  return current;
}

function resolveConfigSetCompletions(words: readonly string[], ctx: CompletionContext): readonly CompletionItem[] {
  const setIndex = words.indexOf('set');
  if (setIndex === -1) return CONFIG_KEY_COMPLETIONS;

  const argsAfterSet = words.slice(setIndex + 1).filter((w) => !w.startsWith('-'));

  if (argsAfterSet.length === 0) return CONFIG_KEY_COMPLETIONS;
  if (argsAfterSet.length === 1 && ctx.last !== '') return CONFIG_KEY_COMPLETIONS;

  const key = argsAfterSet[0];
  if (key === undefined) return CONFIG_KEY_COMPLETIONS;
  return CONFIG_VALUE_COMPLETIONS[key] ?? [];
}

/**
 * Resolve completions for the current input context by introspecting a
 * Commander program. Returns the candidate list the shell should offer.
 */
export async function resolveCompletions(
  program: Command,
  ctx: CompletionContext,
  deps: SharedDeps
): Promise<readonly CompletionItem[]> {
  const words = parseWords(ctx.line);
  const currentCmd = resolveCurrentCommand(program, words);
  const cmdPath = getCommandPath(currentCmd);

  // Special case: `config set <key> <value>` positional shape.
  if (cmdPath === 'config set') {
    return resolveConfigSetCompletions(words, ctx);
  }

  // Previous word is a value-bearing flag.
  if (ctx.prev.startsWith('-')) {
    const resolver = dynamicResolvers[ctx.prev];
    if (resolver !== undefined) {
      return resolver(deps);
    }
    if (optionExpectsValue(currentCmd, ctx.prev)) {
      return [];
    }
  }

  // User is typing a flag.
  if (ctx.last.startsWith('-')) {
    return getOptions(currentCmd);
  }

  // Subcommands available.
  const subs = getSubcommands(currentCmd);
  if (subs.length > 0) return subs;

  // Sprint subcommands accepting a positional argument → suggest sprint IDs.
  if (cmdPath.startsWith('sprint ') && acceptsPositionalArg(currentCmd)) {
    return getSprintCompletions(deps);
  }

  return [];
}
