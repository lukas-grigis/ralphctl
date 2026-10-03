/** Shell-completion script generation. */

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
