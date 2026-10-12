/**
 * Fence for the README capture (`scripts/record-demo.ts`, driven by `.github/assets/demo.tape`).
 *
 * Runs the recorder's own sandbox preparation through the same construction the TUI launch uses —
 * `wire({ providerSpawn })` → `launchFlow('implement', …)` — so a drift that would stop the
 * recording reaching a committed task (a transcript that no longer satisfies a leaf contract, a
 * pacing option that no longer reaches the spawn, a setup script the Prepare step rejects) fails
 * here instead of silently producing a broken GIF. Only the keystrokes the tape types are not
 * exercised; the prompt answers below are the ones those keystrokes pick.
 */

import { promises as fs } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import { storagePathsFromRoot, type StoragePaths } from '@src/application/bootstrap/storage-paths.ts';
import { wire } from '@src/application/bootstrap/wire.ts';
import { DEMO_MARKER_FILENAME } from '@src/application/demo/seed.ts';
import { DEMO_TARGET_FILE } from '@src/application/demo/transcript.ts';
import { launchFlow } from '@src/application/ui/shared/launcher.ts';
import { loadAppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import { passthroughRunInTerminal } from '@src/application/ui/shared/run-in-terminal.ts';
import { runCommand } from '@src/integration/io/run-command.ts';
import { createFsProjectRepository } from '@src/integration/persistence/project/repository.ts';
import { createFsSprintRepository } from '@src/integration/persistence/sprint/repository.ts';
import { createFsTaskRepository } from '@src/integration/persistence/task/repository.ts';
import { createJsonSettingsRepository } from '@src/integration/persistence/settings/json-settings-repository.ts';
import { resolveSprintDir } from '@src/integration/persistence/storage.ts';
import type { ProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';
import { prepareRecording, RECORDING_SETUP_SCRIPT } from '../../../scripts/record-demo.ts';

const FIXED_NOW = (): IsoTimestamp => '2026-08-14T10:00:00.000Z' as IsoTimestamp;
const SESSION_DELAY_MS = 60;

/**
 * The answers the tape's keystrokes give: Enter on "Start (use defaults)" and Enter on the
 * branch-strategy question's first row ("keep current branch") — both the first option.
 */
const tapePrompt = {
  askConfirm: async () => Result.ok(true as boolean),
  askChoice: async <T>(_prompt: string, options: ReadonlyArray<{ readonly value: T }>) => {
    const first = options[0];
    if (first === undefined) throw new Error('tape prompt: askChoice called with no options');
    return Result.ok(first.value);
  },
} as unknown as InteractivePrompt;

let root: string;
let home: AbsolutePath;
let paths: StoragePaths;

const abs = (p: string): AbsolutePath => {
  const parsed = AbsolutePath.parse(p);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};

beforeEach(async () => {
  root = await realpath(await fs.mkdtemp(join(tmpdir(), 'ralphctl-record-demo-')));
  home = abs(join(root, 'home'));
  const resolved = storagePathsFromRoot(home);
  if (!resolved.ok) throw resolved.error;
  paths = resolved.value;
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('scripts/record-demo.ts', () => {
  it('drives the paced recording to a FAIL → PASS → committed implement run', async () => {
    const prepared = await prepareRecording({ homeDir: home, sessionDelayMs: SESSION_DELAY_MS, now: FIXED_NOW });
    if (!prepared.ok) throw prepared.error;

    // The recorder's setup script is what keeps the "no setup script" warning out of the capture.
    const projects = await createFsProjectRepository({ root: paths.dataRoot }).list();
    if (!projects.ok) throw projects.error;
    expect(projects.value.flatMap((p) => p.repositories.map((r) => r.setupScript))).toEqual([RECORDING_SETUP_SCRIPT]);

    const settings = await createJsonSettingsRepository({ configRoot: paths.configRoot }).load();
    if (!settings.ok) throw settings.error;
    // Time each scripted session from spawn to exit — an unpaced scripted child exits within a
    // macrotask, so a lifetime at or above the delay proves the pacing reached the spawn.
    const sessionLifetimesMs: number[] = [];
    const providerSpawn: ProviderSpawn = (command, args, options) => {
      const spawnedAt = performance.now();
      const child = prepared.value.providerSpawn(command, args, options);
      child.once('exit', () => sessionLifetimesMs.push(performance.now() - spawnedAt));
      return child;
    };
    const app = wire({ storage: paths, settings: settings.value, providerSpawn });

    const sprints = await createFsSprintRepository({ root: paths.dataRoot }).list();
    if (!sprints.ok) throw sprints.error;
    const target = sprints.value.find((s) => s.status === 'planned');
    if (target === undefined) throw new Error('the seeded "ready to implement" sprint is missing');

    const snapshot = await loadAppStateSnapshot(
      {
        projectRepo: createFsProjectRepository({ root: paths.dataRoot }),
        sprintRepo: createFsSprintRepository({ root: paths.dataRoot }),
        taskRepo: createFsTaskRepository({ root: paths.dataRoot }),
      },
      { projectId: target.projectId, sprintId: target.id }
    );
    const launched = await launchFlow(
      { app, storage: paths, interactive: tapePrompt, runInTerminal: passthroughRunInTerminal },
      'implement',
      snapshot
    );
    if (!launched.ok) throw new Error(`implement did not launch: ${launched.reason}`);

    await launched.runner.start();
    expect(launched.runner.status).toBe('completed');

    // Two generator + two evaluator sessions, each held open for the pacing delay.
    const names = launched.runner.trace.map((entry) => entry.elementName);
    expect(names.filter((n) => n.startsWith('generator-'))).toHaveLength(2);
    expect(names.filter((n) => n.startsWith('evaluator-'))).toHaveLength(2);
    expect(sessionLifetimesMs).toHaveLength(4);
    // 5ms slack for timer coarseness — setTimeout may fire a hair early relative to performance.now().
    for (const lifetime of sessionLifetimesMs) expect(lifetime).toBeGreaterThanOrEqual(SESSION_DELAY_MS - 5);
    expect(launched.runner.trace.find((entry) => entry.elementName.startsWith('commit-task-'))?.status).toBe(
      'completed'
    );

    const tasks = await createFsTaskRepository({ root: paths.dataRoot }).findBySprintId(target.id);
    if (!tasks.ok) throw tasks.error;
    expect(tasks.value.map((t) => t.status)).toEqual(['done']);

    // Round 1 is the FAIL the GIF exists to show; the committed tree carries round 2's fix.
    const sprintDir = await resolveSprintDir(paths.dataRoot, target.id);
    if (sprintDir === undefined) throw new Error('sprint dir did not resolve');
    const roundOne = join(sprintDir, 'implement', String(tasks.value[0]?.id), 'rounds', '1', 'evaluator');
    expect((await fs.readFile(join(roundOne, 'evaluation.md'), 'utf8')).toLowerCase()).toContain('fail');

    const repoDir = String(prepared.value.repoDir);
    expect(await fs.readFile(join(repoDir, DEMO_TARGET_FILE), 'utf8')).toContain('Hello, world!');
    const status = await runCommand('git', ['-C', repoDir, 'status', '--porcelain']);
    expect(status.stdout.trim()).toBe('');
    const log = await runCommand('git', ['-C', repoDir, 'log', '--format=%s']);
    expect(log.stdout).toContain('fix(demo): print the exact greeting the criterion asks for');
  }, 120_000);

  it('reseeds a demo-owned home but refuses to wipe a directory it did not create', async () => {
    const first = await prepareRecording({ homeDir: home, sessionDelayMs: 0, now: FIXED_NOW });
    if (!first.ok) throw first.error;
    await expect(fs.access(join(String(home), DEMO_MARKER_FILENAME))).resolves.toBeUndefined();

    const again = await prepareRecording({ homeDir: home, sessionDelayMs: 0, now: FIXED_NOW });
    expect(again.ok).toBe(true);

    const foreign = abs(join(root, 'foreign'));
    await fs.mkdir(String(foreign));
    await fs.writeFile(join(String(foreign), 'keep.txt'), 'not a demo sandbox\n');
    const refused = await prepareRecording({ homeDir: foreign, sessionDelayMs: 0, now: FIXED_NOW });
    expect(refused.ok).toBe(false);
    expect(await fs.readFile(join(String(foreign), 'keep.txt'), 'utf8')).toBe('not a demo sandbox\n');
  }, 60_000);

  it('returns a StorageError instead of throwing when --home is a file', async () => {
    const file = abs(join(root, 'not-a-dir'));
    await fs.writeFile(String(file), 'a file, not a home\n');
    const refused = await prepareRecording({ homeDir: file, sessionDelayMs: 0, now: FIXED_NOW });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toBeInstanceOf(StorageError);
    expect(await fs.readFile(String(file), 'utf8')).toBe('a file, not a home\n');
  });
});
