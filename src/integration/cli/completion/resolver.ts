import type { Command } from 'commander';
import type { CompletionItem } from 'tabtab';
import { IOError } from '@src/domain/errors.ts';
import { wrapAsync } from '@src/integration/utils/result-helpers.ts';

export interface CompletionContext {
  /** The full line typed so far */
  line: string;
  /** The last word (what the user is currently typing) */
  last: string;
  /** The word before the last word */
  prev: string;
}

type DynamicResolver = () => Promise<CompletionItem[]>;

const dynamicResolvers: Record<string, DynamicResolver> = {
  '--project': async () => {
    const result = await wrapAsync(
      async () => {
        const { listProjects } = await import('@src/integration/persistence/project.ts');
        return listProjects();
      },
      (err) => new IOError('Failed to load projects for completion', err instanceof Error ? err : undefined)
    );
    if (!result.ok) return [];
    return result.value.map((p) => ({ name: p.name, description: p.displayName }));
  },
  '--status': () => {
    // Context-dependent but we return all possible values — shell filtering handles partial match
    return Promise.resolve([
      { name: 'draft', description: 'Draft sprints' },
      { name: 'active', description: 'Active sprints' },
      { name: 'closed', description: 'Closed sprints' },
      { name: 'todo', description: 'Todo tasks' },
      { name: 'in_progress', description: 'In-progress tasks' },
      { name: 'done', description: 'Done tasks' },
      { name: 'pending', description: 'Pending requirements' },
      { name: 'approved', description: 'Approved requirements' },
    ]);
  },
};

/**
 * Resolve the value completions for `config set <key>` and `config set <key> <value>`.
 */
const configKeyCompletions: CompletionItem[] = [
  { name: 'provider', description: 'AI provider (claude or copilot)' },
  { name: 'editor', description: 'External editor for multiline input' },
];

const configValueCompletions: Record<string, CompletionItem[]> = {
  provider: [
    { name: 'claude', description: 'Claude Code CLI' },
    { name: 'copilot', description: 'GitHub Copilot CLI' },
  ],
};

/**
 * Try to load sprint IDs for positional completion.
 * Degrades gracefully — returns empty on any error.
 */
async function getSprintCompletions(): Promise<CompletionItem[]> {
  const result = await wrapAsync(
    async () => {
      const { listSprints } = await import('@src/integration/persistence/sprint.ts');
      return listSprints();
    },
    (err) => new IOError('Failed to load sprints for completion', err instanceof Error ? err : undefined)
  );
  if (!result.ok) return [];
  return result.value.map((s) => ({
    name: s.id,
    description: `${s.name} (${s.status})`,
  }));
}

/**
 * Get all commands from a Commander command (direct children).
 */
function getSubcommands(cmd: Command): CompletionItem[] {
  return cmd.commands.map((sub: Command) => ({
    name: sub.name(),
    description: sub.description(),
  }));
}

/**
 * Get all options from a Commander command.
 */
function getOptions(cmd: Command): CompletionItem[] {
  const items: CompletionItem[] = [];
  for (const opt of cmd.options) {
    // Prefer long flag, fall back to short
    const flag = opt.long ?? opt.short;
    if (flag) {
      items.push({ name: flag, description: opt.description });
    }
  }
  return items;
}

/**
 * Find a subcommand by name.
 */
function findSubcommand(cmd: Command, name: string): Command | undefined {
  return cmd.commands.find((sub: Command) => sub.name() === name);
}

/**
 * Check whether the given option expects a value argument (not boolean).
 */
function optionExpectsValue(cmd: Command, flag: string): boolean {
  const opt = cmd.options.find((o) => o.long === flag || o.short === flag);
  if (!opt) return false;
  // Commander: boolean flags (--force) have required=false and optional=false
  return opt.required || opt.optional;
}

/**
 * Parse words out of the completion line (skipping the program name).
 */
function parseWords(line: string): string[] {
  return line.trim().split(/\s+/).slice(1);
}

/**
 * Resolve completions for the current input context by introspecting a Commander program.
 */
export async function resolveCompletions(program: Command, ctx: CompletionContext): Promise<CompletionItem[]> {
  const words = parseWords(ctx.line);

  // Walk the Commander tree to find the deepest matching command
  let currentCmd = program;
  let wordIndex = 0;

  while (wordIndex < words.length) {
    const word = words[wordIndex];
    if (!word) break;

    // Skip flags and their values during traversal
    if (word.startsWith('-')) {
      wordIndex++;
      // If the flag expects a value, skip the next word too
      if (optionExpectsValue(currentCmd, word) && wordIndex < words.length) {
        wordIndex++;
      }
      continue;
    }

    const sub = findSubcommand(currentCmd, word);
    if (sub) {
      currentCmd = sub;
      wordIndex++;
    } else {
      break;
    }
  }

  // Special case: `config set` positional args
  const cmdPath = getCommandPath(currentCmd);
  if (cmdPath === 'config set') {
    return resolveConfigSetCompletions(words, ctx);
  }

  // If the previous word is a flag that expects a value → resolve that value
  if (ctx.prev.startsWith('-')) {
    // Check for dynamic resolver
    const resolver = dynamicResolvers[ctx.prev];
    if (resolver) {
      return resolver();
    }

    // If the option expects a value but we have no resolver, return empty (let user type)
    if (optionExpectsValue(currentCmd, ctx.prev)) {
      return [];
    }
  }

  // If the user is typing a flag (starts with -)
  if (ctx.last.startsWith('-')) {
    return getOptions(currentCmd);
  }

  // If the command has subcommands, offer those
  const subs = getSubcommands(currentCmd);
  if (subs.length > 0) {
    return subs;
  }

  // For commands that accept a positional [id] argument (sprint subcommands), offer sprint IDs
  if (cmdPath.startsWith('sprint ') && acceptsPositionalArg(currentCmd)) {
    return getSprintCompletions();
  }

  return [];
}

/**
 * Get the full command path (e.g. "sprint start", "config set").
 */
function getCommandPath(cmd: Command): string {
  const parts: string[] = [];
  let current: Command = cmd;
  while (current.parent) {
    parts.unshift(current.name());
    current = current.parent;
  }
  return parts.join(' ');
}

/**
 * Check whether a command accepts positional arguments (has [id] or similar in usage).
 */
function acceptsPositionalArg(cmd: Command): boolean {
  // Commander stores registered args
  return cmd.registeredArguments.length > 0;
}

/**
 * Handle completions for `config set <key> [value]`.
 */
function resolveConfigSetCompletions(words: string[], ctx: CompletionContext): Promise<CompletionItem[]> {
  const setIndex = words.indexOf('set');

  if (setIndex === -1) {
    return Promise.resolve(configKeyCompletions);
  }

  // Positional args after "set" (excluding flags)
  const argsAfterSet = words.slice(setIndex + 1).filter((w) => !w.startsWith('-'));

  // No args yet, or typing a partial key → suggest keys
  if (argsAfterSet.length === 0) {
    return Promise.resolve(configKeyCompletions);
  }

  // One arg present and user is still typing it (last word matches the arg) → suggest keys
  if (argsAfterSet.length === 1 && ctx.last !== '') {
    return Promise.resolve(configKeyCompletions);
  }

  // One arg present and cursor moved past it (last is empty) → suggest values for that key
  // OR two args present (user is typing the value) → suggest values for the first arg
  const key = argsAfterSet[0];
  const values = key ? configValueCompletions[key] : undefined;
  return Promise.resolve(values ?? []);
}
