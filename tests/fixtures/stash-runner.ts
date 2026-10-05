import { okGit } from '@tests/fixtures/git-result.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';

/** Scripted `git stash list` / `git stash show --numstat` answers for one stash entry. */
export const stashRunner = (opts: {
  /** The subject git shows for the entry, e.g. `On main: <stash message>`. */
  readonly subject: string;
  /** Raw numstat rows, `<added>\t<deleted>\t<path>`. */
  readonly numstat: readonly string[];
}): GitRunner => ({
  async run(_cwd, args) {
    if (args[0] === 'stash' && args[1] === 'list') return okGit(`stash@{0}\x1f${opts.subject}\n`);
    if (args[0] === 'stash' && args[1] === 'show') return okGit(`${opts.numstat.join('\n')}\n`);
    return okGit('');
  },
});

/** A runner whose every git call reports no stash. */
export const emptyStashRunner = (): GitRunner => ({
  async run() {
    return okGit('');
  },
});

/** Scripted stash stack holding several entries, newest first; `show` answers per ref. */
export const stashEntriesRunner = (
  entries: ReadonlyArray<{ readonly subject: string; readonly numstat: readonly string[] }>
): GitRunner => ({
  async run(_cwd, args) {
    if (args[0] === 'stash' && args[1] === 'list') {
      return okGit(entries.map((e, i) => `stash@{${String(i)}}\x1f${e.subject}\n`).join(''));
    }
    if (args[0] === 'stash' && args[1] === 'show') {
      const idx = /stash@\{(\d+)\}/.exec(args.at(-1) ?? '')?.[1];
      return okGit(`${(entries[Number(idx)]?.numstat ?? []).join('\n')}\n`);
    }
    return okGit('');
  },
});
