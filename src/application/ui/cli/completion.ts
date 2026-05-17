/**
 * Shell-completion script generation. Static templates per shell; the command list is
 * derived from the registered flow ids plus the CLI-only top-level commands. Output goes to
 * stdout — users redirect into their shell config (`>> ~/.bashrc` / `~/.zshrc`).
 *
 * Subcommands and option flags are intentionally not modeled — completing the top-level verb
 * covers the common case and avoids coupling completion to commander internals. A richer
 * generator can replace this when the CLI surface stabilises.
 */

import { flowRegistry } from '@src/application/registry.ts';

export type Shell = 'bash' | 'zsh';

const CLI_ONLY_COMMANDS = ['doctor', 'settings', 'completion'] as const;

const collectCommands = (): readonly string[] => {
  const flowIds = flowRegistry.map((entry) => entry.manifest.id);
  return [...new Set([...flowIds, ...CLI_ONLY_COMMANDS])].sort();
};

const bashScript = (commands: readonly string[]): string => `# ralphctl bash completion — source from ~/.bashrc
_ralphctl_complete() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local commands="${commands.join(' ')}"
  COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
}
complete -F _ralphctl_complete ralphctl
`;

const zshScript = (commands: readonly string[]): string => `#compdef ralphctl
# ralphctl zsh completion — source from ~/.zshrc (or place under $fpath)
_ralphctl() {
  local -a commands
  commands=(${commands.map((c) => `'${c}'`).join(' ')})
  _describe 'command' commands
}
_ralphctl "$@"
`;

export const generateCompletion = (shell: Shell): string => {
  const commands = collectCommands();
  switch (shell) {
    case 'bash':
      return bashScript(commands);
    case 'zsh':
      return zshScript(commands);
  }
};
