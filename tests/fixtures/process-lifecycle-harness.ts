/**
 * Stand-in harness process for the orphan-reaper test: wires the app exactly as the TUI does, tracks
 * one run, and has it spawn the headless provider (a stub `claude` the test puts first on PATH).
 * The test SIGKILLs this process and checks what survives it.
 *
 *   node --import tsx tests/fixtures/process-lifecycle-harness.ts <appRoot> <cwd>
 */

import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { ensureStorageRoots, storagePathsFromRoot } from '@src/application/bootstrap/storage-paths.ts';
import { wire } from '@src/application/bootstrap/wire.ts';
import { createRunner } from '@src/application/chain/run/runner.ts';
import type { Element } from '@src/application/chain/element.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { READ_ONLY } from '@src/integration/ai/providers/_engine/session-permissions.ts';

const [appRootArg, cwdArg] = process.argv.slice(2);
const parse = (raw: string | undefined): AbsolutePath => {
  const parsed = AbsolutePath.parse(raw ?? '');
  if (!parsed.ok) throw new Error(`not an absolute path: ${String(raw)}`);
  return parsed.value;
};
const appRoot = parse(appRootArg);
const cwd = parse(cwdArg);

const paths = storagePathsFromRoot(appRoot);
if (!paths.ok) throw paths.error;
await ensureStorageRoots(paths.value);
const deps = wire({ storage: paths.value, settings: DEFAULT_SETTINGS });

const element: Element<object> = {
  name: 'spawn-stub-cli',
  execute: async (ctx, signal) => {
    await deps.provider.generate({
      prompt: 'stub prompt' as Prompt,
      cwd,
      model: 'claude-sonnet-4-6',
      permissions: READ_ONLY,
      signalsFile: parse(join(String(cwd), 'rounds', '3', 'generator', 'signals.json')),
      role: 'generator',
      ...(signal !== undefined ? { abortSignal: signal } : {}),
    });
    return Result.ok({ ctx, trace: [] });
  },
};
const runner = createRunner({ id: 'r-reaper-test', element, initialCtx: {} });
deps.inProcessRuns.track(runner, { flowId: 'implement', sprintId: 'sprint-1' });
void runner.start();
setInterval(() => {}, 1_000);
