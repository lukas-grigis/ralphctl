/**
 * End-to-end fence for `ralphctl demo --script`.
 *
 * Everything except the model is real: the seeded sandbox comes from `seedDemoWorkspace`, the
 * app graph from `wire()`, the chain from `launchFlow('implement', …)`, git from the real
 * `GitRunner`, and the verify gate from the real shell runner. Only the AI sessions are
 * scripted, through `AppDeps.providerSpawn`.
 *
 * That combination is what makes this test worth its runtime: it is the only place that proves
 * the spawn override survives the per-launch adapter rebuild (it used to be silently dropped),
 * that the canned transcript actually satisfies the leaf contracts, and that the two-round
 * FAIL → PASS story really settles the task `done` with a real commit behind it.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { type IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import {
  ensureStorageRoots,
  storagePathsFromRoot,
  type StoragePaths,
} from '@src/application/bootstrap/storage-paths.ts';
import { wire } from '@src/application/bootstrap/wire.ts';
import { seedDemoWorkspace } from '@src/application/demo/seed.ts';
import { prepareScriptedDemo } from '@src/application/demo/scripted-run.ts';
import { DEMO_TARGET_FILE } from '@src/application/demo/transcript.ts';
import { launchFlow, type LauncherDeps } from '@src/application/ui/shared/launcher.ts';
import { loadAppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import { passthroughRunInTerminal } from '@src/application/ui/shared/run-in-terminal.ts';
import { runCommand } from '@src/integration/io/run-command.ts';
import { createAtomicWriteFile } from '@src/integration/io/write-file-atomic.ts';
import { createFsProjectRepository } from '@src/integration/persistence/project/repository.ts';
import { createFsSprintRepository } from '@src/integration/persistence/sprint/repository.ts';
import { createFsTaskRepository } from '@src/integration/persistence/task/repository.ts';
import { createJsonSettingsRepository } from '@src/integration/persistence/settings/json-settings-repository.ts';
import { resolveSprintDir } from '@src/integration/persistence/storage.ts';

const FIXED_NOW = (): IsoTimestamp => '2026-08-14T10:00:00.000Z' as IsoTimestamp;

/**
 * Answers every gate without a human. `askChoice` takes the FIRST option, which for the
 * branch-strategy question is "keep current branch" — the sandbox repo is a throwaway `git init`
 * on `main`, so there is nothing to protect by branching.
 */
const scriptedPrompt = {
  askConfirm: async () => Result.ok(true as boolean),
  askChoice: async <T>(_prompt: string, options: ReadonlyArray<{ readonly value: T }>) => {
    const first = options[0];
    if (first === undefined) throw new Error('scripted prompt: askChoice called with no options');
    return Result.ok(first.value);
  },
} as unknown as InteractivePrompt;

let home: AbsolutePath;
let paths: StoragePaths;

const abs = (p: string): AbsolutePath => {
  const parsed = AbsolutePath.parse(p);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};

beforeEach(async () => {
  home = abs(await realpath(await fs.mkdtemp(join(tmpdir(), 'ralphctl-demo-e2e-'))));
  const resolved = storagePathsFromRoot(home);
  if (!resolved.ok) throw resolved.error;
  paths = resolved.value;
  const ensured = await ensureStorageRoots(paths);
  if (!ensured.ok) throw ensured.error;
});

afterEach(async () => {
  await fs.rm(String(home), { recursive: true, force: true });
});

describe('ralphctl demo --script', () => {
  it('drives a two-round FAIL → PASS implement run against the seeded sandbox', async () => {
    const seeded = await seedDemoWorkspace(
      { runCommand, writeFile: createAtomicWriteFile() },
      { homeDir: home, token: 'e2edemo' }
    );
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;

    const scripted = await prepareScriptedDemo({ homeDir: home, now: FIXED_NOW });
    expect(scripted.ok).toBe(true);
    if (!scripted.ok) return;

    const settings = await createJsonSettingsRepository({ configRoot: paths.configRoot }).load();
    expect(settings.ok).toBe(true);
    if (!settings.ok) return;
    // The scripted sandbox is claude-only — the transcript emulates exactly one stream format.
    expect(settings.value.ai.implement.generator.provider).toBe('claude-code');
    expect(settings.value.ai.implement.evaluator.provider).toBe('claude-code');

    const app = wire({ storage: paths, settings: settings.value, providerSpawn: scripted.value.providerSpawn });
    const deps: LauncherDeps = {
      app,
      storage: paths,
      interactive: scriptedPrompt,
      runInTerminal: passthroughRunInTerminal,
    };

    const projects = await createFsProjectRepository({ root: paths.dataRoot }).list();
    expect(projects.ok).toBe(true);
    if (!projects.ok) return;
    const sprints = await createFsSprintRepository({ root: paths.dataRoot }).list();
    expect(sprints.ok).toBe(true);
    if (!sprints.ok) return;
    const target = sprints.value.find((s) => s.status === 'planned');
    expect(target).toBeDefined();
    if (target === undefined) return;

    const snapshot = await loadAppStateSnapshot(
      {
        projectRepo: createFsProjectRepository({ root: paths.dataRoot }),
        sprintRepo: createFsSprintRepository({ root: paths.dataRoot }),
        taskRepo: createFsTaskRepository({ root: paths.dataRoot }),
      },
      { projectId: target.projectId, sprintId: target.id }
    );

    const launched = await launchFlow(deps, 'implement', snapshot);
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;

    await launched.runner.start();
    expect(launched.runner.status).toBe('completed');

    // Two generator turns and two evaluator turns — the FAIL round and the PASS round.
    const names = launched.runner.trace.map((entry) => entry.elementName);
    expect(names.filter((n) => n.startsWith('generator-'))).toHaveLength(2);
    expect(names.filter((n) => n.startsWith('evaluator-'))).toHaveLength(2);
    // The commit leaf actually ran — a skipped commit means the round was rejected, which is how
    // an earlier iteration of this transcript failed silently while the trace still looked plausible.
    const commitStep = launched.runner.trace.find((entry) => entry.elementName.startsWith('commit-task-'));
    expect(commitStep?.status).toBe('completed');

    // The task settled done off the PASSing second round.
    const tasks = await createFsTaskRepository({ root: paths.dataRoot }).findBySprintId(target.id);
    expect(tasks.ok).toBe(true);
    if (!tasks.ok) return;
    expect(tasks.value.map((t) => t.status)).toEqual(['done']);

    // The generator's edits are real: the file on disk carries the corrected greeting and the
    // commit leaf recorded it.
    const source = await fs.readFile(join(String(seeded.value.repoDir), DEMO_TARGET_FILE), 'utf8');
    expect(source).toContain('Hello, world!');
    const log = await runCommand('git', ['-C', String(seeded.value.repoDir), 'log', '--oneline']);
    expect(log.ok).toBe(true);
    expect(log.stdout).toContain('greeting');

    // No real CLI was spawned: the session ids on disk are the scripted transcript's, and the
    // first round's evaluation is the FAIL verdict.
    const sprintDir = await resolveSprintDir(paths.dataRoot, target.id);
    expect(sprintDir).toBeDefined();
    if (sprintDir === undefined) return;
    const taskId = String(tasks.value[0]?.id);
    const roundOne = join(sprintDir, 'implement', taskId, 'rounds', '1');
    const sessionId = await fs.readFile(join(roundOne, 'generator', 'session-id.txt'), 'utf8');
    expect(sessionId.trim()).toBe('demo-scripted-generator');
    const verdict = await fs.readFile(join(roundOne, 'evaluator', 'evaluation.md'), 'utf8');
    expect(verdict.toLowerCase()).toContain('fail');
  }, 120_000);
});
