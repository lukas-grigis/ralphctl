/**
 * Shell-completion script generation. The command list is supplied by the caller, derived from
 * the live commander program's registered subcommands (see `registerCompletionCommand`) — so the
 * completion stays self-maintaining as commands are added or removed and never drifts from the
 * actual CLI surface. Output goes to stdout — users redirect into their shell config
 * (`>> ~/.bashrc` / `~/.zshrc`).
 *
 * Subcommands and option flags are intentionally not modeled — completing the top-level verb
 * covers the common case and avoids coupling completion to commander internals. A richer
 * generator can replace this when the CLI surface stabilises.
 */

export type Shell = 'bash' | 'zsh';

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

export const generateCompletion = (shell: Shell, commands: readonly string[]): string => {
  const sorted = [...new Set(commands)].sort();
  switch (shell) {
    case 'bash':
      return bashScript(sorted);
    case 'zsh':
      return zshScript(sorted);
  }
};
