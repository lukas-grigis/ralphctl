/**
 * Stand-in harness process for the git-hook reaper test: wires the app exactly as the TUI does and
 * commits through the wired git runner; the test's pre-commit hook hangs. The test SIGKILLs this
 * process and checks whether the hook outlives it.
 *
 *   node --import tsx tests/fixtures/git-hook-harness.ts <appRoot> <repo>
 */

import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { ensureStorageRoots, storagePathsFromRoot } from '@src/application/bootstrap/storage-paths.ts';
import { wire } from '@src/application/bootstrap/wire.ts';
import { gitCommitWithMessage } from '@src/integration/io/git-operations.ts';

const [appRootArg, repoArg] = process.argv.slice(2);
const parse = (raw: string | undefined): AbsolutePath => {
  const parsed = AbsolutePath.parse(raw ?? '');
  if (!parsed.ok) throw new Error(`not an absolute path: ${String(raw)}`);
  return parsed.value;
};

const paths = storagePathsFromRoot(parse(appRootArg));
if (!paths.ok) throw paths.error;
await ensureStorageRoots(paths.value);
const deps = wire({ storage: paths.value, settings: DEFAULT_SETTINGS });
void gitCommitWithMessage(deps.gitRunner, parse(repoArg), 'commit through the wired runner');
setInterval(() => {}, 1_000);
