/**
 * `completion install` / `completion show` — wire up shell tab-completion.
 *
 *  - `install [--shell bash|zsh|fish]` appends a source line to the user's
 *    shell rc file. `--shell` is auto-detected from `$SHELL` when omitted.
 *  - `show [--shell …]` prints the completion script to stdout — useful
 *    for sandboxed installs (homebrew, distros) that prefer a manual hook.
 *
 * The completion script invokes `ralphctl completion --` with `COMP_*` env
 * vars set; `entrypoint.ts` intercepts that early and routes to
 * `handleCompletionRequest`, so the user's shell receives the candidate
 * list.
 */
import { appendFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Command } from 'commander';
import * as c from 'colorette';

import type { SharedDeps } from '../../bootstrap/shared-deps.ts';
import { EXIT_ERROR, EXIT_SUCCESS, type ExitCode } from '../exit-codes.ts';

export type SupportedShell = 'bash' | 'zsh' | 'fish';

interface InstallOptions {
  shell?: string;
}

export function attachCompletion(program: Command, deps: SharedDeps): void {
  const completion = program.command('completion').description('manage shell tab-completion');

  completion.addHelpText(
    'after',
    `
Examples:
  $ ralphctl completion install                  # auto-detect shell
  $ ralphctl completion install --shell zsh      # explicit shell
  $ ralphctl completion show --shell bash > ~/.ralphctl-completion.bash
`
  );

  completion
    .command('install')
    .description('install shell tab-completion (bash, zsh, fish)')
    .option('--shell <shell>', 'shell to install for (bash|zsh|fish; auto-detected when omitted)')
    .action(async (opts: InstallOptions) => {
      const code = await runCompletionInstall(deps, opts.shell);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });

  completion
    .command('show')
    .description('print the completion script for a shell to stdout')
    .option('--shell <shell>', 'shell to print the script for (bash|zsh|fish; auto-detected when omitted)')
    .action(async (opts: InstallOptions) => {
      const code = await runCompletionShow(opts.shell);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });

  // The bare `completion` action is the runtime intercept used by tabtab —
  // when the shell triggers completion it sets `COMP_*` env vars and runs
  // `ralphctl completion -- <words…>`. The intercept lives in
  // `entrypoint.ts` (early) and renders the candidate list. The action below
  // is a no-op fallback so `ralphctl completion` (without subcommand) still
  // exits cleanly when the user invokes it interactively without env vars.
  completion.action(() => {
    // no-op
  });
}

/** Resolve the requested shell, defaulting to the env's `$SHELL` basename. */
export function resolveShell(requested: string | undefined): string {
  if (requested !== undefined && requested.length > 0) return requested;
  const fromEnv = process.env['SHELL'];
  if (fromEnv === undefined || fromEnv.length === 0) return 'bash';
  const base = fromEnv.split('/').pop() ?? '';
  return base === '' ? 'bash' : base;
}

function isSupportedShell(s: string): s is SupportedShell {
  return s === 'bash' || s === 'zsh' || s === 'fish';
}

/** Render the shell-specific completion script with the given binary name. */
export function buildCompletionScript(shell: SupportedShell, binary = 'ralphctl'): string {
  switch (shell) {
    case 'bash':
      return [
        `###-begin-${binary}-completion-###`,
        `if type complete &>/dev/null; then`,
        `  _${binary}_completion () {`,
        `    local words cword`,
        `    if type _get_comp_words_by_ref &>/dev/null; then`,
        `      _get_comp_words_by_ref -n = -n @ -n : -w words -i cword`,
        `    else`,
        `      cword="$COMP_CWORD"`,
        `      words=("\${COMP_WORDS[@]}")`,
        `    fi`,
        `    local si="$IFS"`,
        `    IFS=$'\\n' COMPREPLY=($(COMP_CWORD="$cword" \\`,
        `                           COMP_LINE="$COMP_LINE" \\`,
        `                           COMP_POINT="$COMP_POINT" \\`,
        `                           ${binary} completion -- "\${words[@]}" \\`,
        `                           2>/dev/null)) || return $?`,
        `    IFS="$si"`,
        `    if type __ltrim_colon_completions &>/dev/null; then`,
        `      __ltrim_colon_completions "\${words[cword]}"`,
        `    fi`,
        `  }`,
        `  complete -o default -F _${binary}_completion ${binary}`,
        `fi`,
        `###-end-${binary}-completion-###`,
        '',
      ].join('\n');
    case 'zsh':
      return [
        `###-begin-${binary}-completion-###`,
        `if type compdef &>/dev/null; then`,
        `  _${binary}_completion () {`,
        `    local reply`,
        `    local si=$IFS`,
        `    IFS=$'\\n' reply=($(COMP_CWORD="$((CURRENT-1))" COMP_LINE="$BUFFER" COMP_POINT="$CURSOR" ${binary} completion -- "\${words[@]}"))`,
        `    IFS=$si`,
        `    _describe 'values' reply`,
        `  }`,
        `  compdef _${binary}_completion ${binary}`,
        `fi`,
        `###-end-${binary}-completion-###`,
        '',
      ].join('\n');
    case 'fish':
      return [
        `###-begin-${binary}-completion-###`,
        `function _${binary}_completion`,
        `  set cmd (commandline -o)`,
        `  set cursor (commandline -C)`,
        `  set words (count (string split ' ' -- "$cmd"))`,
        `  set completions (eval env COMP_CWORD=\\""$words\\"" COMP_LINE=\\""$cmd \\"" COMP_POINT=\\""$cursor\\"" ${binary} completion -- $cmd)`,
        `  for completion in $completions`,
        `    echo -e $completion`,
        `  end`,
        `end`,
        `complete -f -d '${binary}' -c ${binary} -a "(eval _${binary}_completion)"`,
        `###-end-${binary}-completion-###`,
        '',
      ].join('\n');
  }
}

/** rc-file location for the named shell. */
export function rcFileForShell(shell: SupportedShell): string {
  const home = homedir();
  switch (shell) {
    case 'bash':
      return join(home, '.bashrc');
    case 'zsh':
      return join(home, '.zshrc');
    case 'fish':
      return join(home, '.config', 'fish', 'config.fish');
  }
}

export function runCompletionShow(requestedShell: string | undefined): Promise<ExitCode> {
  const shell = resolveShell(requestedShell);
  if (!isSupportedShell(shell)) {
    process.stderr.write(`${c.red('error')} unsupported shell: ${shell} (expected bash | zsh | fish)\n`);
    return Promise.resolve(EXIT_ERROR);
  }
  process.stdout.write(buildCompletionScript(shell));
  return Promise.resolve(EXIT_SUCCESS);
}

export async function runCompletionInstall(deps: SharedDeps, requestedShell: string | undefined): Promise<ExitCode> {
  const shell = resolveShell(requestedShell);
  if (!isSupportedShell(shell)) {
    process.stderr.write(`${c.red('error')} unsupported shell: ${shell} (expected bash | zsh | fish)\n`);
    return EXIT_ERROR;
  }

  const script = buildCompletionScript(shell);
  const rcPath = rcFileForShell(shell);
  const marker = `###-begin-ralphctl-completion-###`;

  // Idempotent: skip when the marker is already present.
  let existing = '';
  try {
    existing = await readFile(rcPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`${c.red('error')} cannot read ${rcPath}: ${(err as Error).message}\n`);
      return EXIT_ERROR;
    }
  }

  if (existing.includes(marker)) {
    process.stdout.write(`${c.dim('already installed')} — ${rcPath} contains a ralphctl completion block\n`);
    deps.logger.info('completion already installed', { shell, rcPath });
    return EXIT_SUCCESS;
  }

  try {
    await appendFile(rcPath, `\n# ralphctl completion (added by 'ralphctl completion install')\n${script}`);
  } catch (err) {
    process.stderr.write(`${c.red('error')} failed to update ${rcPath}: ${(err as Error).message}\n`);
    return EXIT_ERROR;
  }

  process.stdout.write(
    `${c.green('installed')} ralphctl completion for ${c.bold(shell)}\n` +
      `  ${c.dim('rc file:')} ${rcPath}\n` +
      `  ${c.dim('reload :')} restart your shell or run \`source ${rcPath}\`\n`
  );
  deps.logger.info('completion installed', { shell, rcPath });
  return EXIT_SUCCESS;
}
