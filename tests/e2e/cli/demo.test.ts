import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { storagePathsFromRoot } from '@src/application/bootstrap/storage-paths.ts';
import { createFsProjectRepository } from '@src/integration/persistence/project/repository.ts';
import { createFsSprintRepository } from '@src/integration/persistence/sprint/repository.ts';
import { createJsonSettingsRepository } from '@src/integration/persistence/settings/json-settings-repository.ts';
import { DEMO_MARKER_FILENAME } from '@src/application/demo/seed.ts';
import { type AiSettings, primaryFlowRow } from '@src/domain/entity/settings.ts';
import { FLOW_IDS } from '@src/domain/value/flow-id.ts';
import { type CliHome, createCliHome, runCliCaptured } from '@tests/e2e/cli/_harness.ts';

const loadSeededAi = async (homeDirStr: string): Promise<AiSettings> => {
  const homeAbs = AbsolutePath.parse(homeDirStr);
  if (!homeAbs.ok) throw new Error('unreachable');
  const paths = storagePathsFromRoot(homeAbs.value);
  if (!paths.ok) throw new Error('unreachable');
  const loaded = await createJsonSettingsRepository({ configRoot: paths.value.configRoot }).load();
  if (!loaded.ok) throw new Error(`settings load failed: ${loaded.error.message}`);
  return loaded.value.ai;
};

describe('ralphctl demo', () => {
  let cli: CliHome;
  let demoParent: string;
  let demoHome: string;

  beforeEach(async () => {
    // `createCliHome` gives us a scratch RALPHCTL_HOME for the harness to point commander's
    // own bootstrap at (unused by `demo`, which takes an explicit `--home`), plus a fresh
    // sibling directory for the sandbox itself. `demoHome` is a child of `demoParent` (`demo`
    // refuses to seed into an existing, unmarked directory) — cleanup removes the mkdtemp'd
    // parent, not just the child, or the parent leaks on every run.
    cli = await createCliHome();
    demoParent = await fs.mkdtemp(join(tmpdir(), 'ralphctl-demo-e2e-'));
    demoHome = join(demoParent, 'sandbox');
  });

  afterEach(async () => {
    await cli.cleanup();
    await fs.rm(demoParent, { recursive: true, force: true });
  });

  it('seeds a project + three sprints readable through the fs repositories', async () => {
    const result = await runCliCaptured(cli, ['demo', '--home', demoHome, '--no-launch']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Demo workspace seeded');
    expect(result.stdout).toContain('ready to refine');
    expect(result.stdout).toContain('ready to plan');
    expect(result.stdout).toContain('ready to implement');

    const homeAbs = AbsolutePath.parse(demoHome);
    expect(homeAbs.ok).toBe(true);
    if (!homeAbs.ok) return;
    const paths = storagePathsFromRoot(homeAbs.value);
    expect(paths.ok).toBe(true);
    if (!paths.ok) return;

    const projects = await createFsProjectRepository({ root: paths.value.dataRoot }).list();
    expect(projects.ok).toBe(true);
    if (projects.ok) expect(projects.value).toHaveLength(1);

    const sprints = await createFsSprintRepository({ root: paths.value.dataRoot }).list();
    expect(sprints.ok).toBe(true);
    if (sprints.ok) expect(sprints.value).toHaveLength(3);
  });

  it('prints the launch command instead of mounting the TUI', async () => {
    const result = await runCliCaptured(cli, ['demo', '--home', demoHome, '--no-launch']);
    expect(result.stdout).toContain('Launch it with:');
    expect(result.stdout).toContain(`RALPHCTL_HOME=${demoHome} ralphctl`);
  });

  it('writes a settings.json so the welcome flow is skipped', async () => {
    await runCliCaptured(cli, ['demo', '--home', demoHome, '--no-launch']);
    const homeAbs = AbsolutePath.parse(demoHome);
    if (!homeAbs.ok) throw new Error('unreachable');
    const paths = storagePathsFromRoot(homeAbs.value);
    if (!paths.ok) throw new Error('unreachable');
    const settingsRepo = createJsonSettingsRepository({ configRoot: paths.value.configRoot });
    const exists = await settingsRepo.exists();
    expect(exists.ok).toBe(true);
    if (exists.ok) expect(exists.value).toBe(true);
  });

  it('seeds a single-provider AI section — no cross-provider implement split', async () => {
    // The shipped DEFAULT_SETTINGS split the implement roles across claude-code + openai-codex,
    // which made the sandbox's "ready to implement" sprint need TWO CLIs on a command that
    // advertises zero setup. Whatever this machine has installed, the demo must land on one
    // provider — that invariant holds on every developer box and in CI.
    await runCliCaptured(cli, ['demo', '--home', demoHome, '--no-launch']);
    const ai = await loadSeededAi(demoHome);
    expect(ai.implement.generator.provider).toBe(ai.implement.evaluator.provider);
    const providers = new Set([
      ...FLOW_IDS.map((flow) => primaryFlowRow(ai, flow).provider),
      ai.implement.evaluator.provider,
    ]);
    expect(providers.size).toBe(1);
  });

  it('--script still pins every AI row to claude-code (scripted settings win last)', async () => {
    await runCliCaptured(cli, ['demo', '--home', demoHome, '--no-launch', '--script']);
    const ai = await loadSeededAi(demoHome);
    expect(ai.implement.generator.provider).toBe('claude-code');
    expect(ai.implement.evaluator.provider).toBe('claude-code');
    expect(new Set(FLOW_IDS.map((flow) => primaryFlowRow(ai, flow).provider))).toEqual(new Set(['claude-code']));
  });

  it('writes the .ralphctl-demo marker and is idempotent (wipes + reseeds) on re-run', async () => {
    const first = await runCliCaptured(cli, ['demo', '--home', demoHome, '--no-launch']);
    expect(first.exitCode).toBe(0);
    const markerPath = join(demoHome, DEMO_MARKER_FILENAME);
    await expect(fs.access(markerPath)).resolves.toBeUndefined();

    const firstProjectName = first.stdout.match(/project : (.+)/)?.[1];
    expect(firstProjectName).toBeDefined();

    const second = await runCliCaptured(cli, ['demo', '--home', demoHome, '--no-launch']);
    expect(second.exitCode).toBe(0);
    const secondProjectName = second.stdout.match(/project : (.+)/)?.[1];
    // A fresh per-run token means a fresh project name — proves the sandbox was actually wiped
    // and reseeded, not additively appended to.
    expect(secondProjectName).not.toBe(firstProjectName);

    const homeAbs = AbsolutePath.parse(demoHome);
    if (!homeAbs.ok) throw new Error('unreachable');
    const paths = storagePathsFromRoot(homeAbs.value);
    if (!paths.ok) throw new Error('unreachable');
    const projects = await createFsProjectRepository({ root: paths.value.dataRoot }).list();
    expect(projects.ok).toBe(true);
    if (projects.ok) expect(projects.value).toHaveLength(1);
  });

  it('refuses to wipe an existing directory that lacks the .ralphctl-demo marker', async () => {
    await fs.mkdir(demoHome, { recursive: true });
    await fs.writeFile(join(demoHome, 'unrelated-file.txt'), 'do not touch me');

    const result = await runCliCaptured(cli, ['demo', '--home', demoHome, '--no-launch']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('refusing to wipe it');
    // The unrelated file must survive untouched.
    await expect(fs.access(join(demoHome, 'unrelated-file.txt'))).resolves.toBeUndefined();
  });
});
