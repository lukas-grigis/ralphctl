import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger, LogMeta } from '@src/business/observability/logger.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Skill } from '@src/integration/ai/skills/_engine/skill.ts';
import { createFilesystemSkillsAdapter } from '@src/integration/ai/skills/_engine/filesystem-skills-adapter.ts';
import { INSTALL_MARKER_FILENAME } from '@src/integration/ai/skills/_engine/skill-install-marker.ts';

/** INT32_MAX sits above every platform's pid ceiling, so no live process ever has it. */
const DEAD_PID = 2_147_483_647;
const NAME = 'ralphctl-alignment';

const makeSession = async (): Promise<AbsolutePath> => {
  const dir = await mkdtemp(join(tmpdir(), 'skills-stale-install-'));
  const parsed = AbsolutePath.parse(dir);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
};

const skill = (body: string): Skill => ({ name: NAME, description: `desc for ${NAME}`, content: body });

const skillDir = (session: AbsolutePath): string => join(String(session), '.claude/skills', NAME);

/** One `info`/`warn` call captured by {@link recordingLogger}. */
interface RecordedLog {
  readonly message: string;
  readonly meta: LogMeta | undefined;
}

const recordingLogger = (): {
  readonly logger: Logger;
  readonly warnings: string[];
  readonly infos: RecordedLog[];
} => {
  const warnings: string[] = [];
  const infos: RecordedLog[] = [];
  const logger: Logger = {
    debug() {},
    info(message, meta) {
      infos.push({ message, meta });
    },
    warn(message) {
      warnings.push(message);
    },
    error() {},
    named: () => logger,
  };
  return { logger, warnings, infos };
};

const newAdapter = (logger?: Logger) =>
  createFilesystemSkillsAdapter({
    providerId: 'test-provider',
    parentDir: '.claude',
    convention: 'n/a',
    ...(logger !== undefined ? { logger } : {}),
  });

/** Put a skill folder on disk the way an earlier run (or the operator) left it. */
const plantFolder = async (
  session: AbsolutePath,
  opts: { readonly body: string; readonly marker?: string; readonly extraFile?: string }
): Promise<string> => {
  const dst = skillDir(session);
  await mkdir(dst, { recursive: true });
  await writeFile(join(dst, 'SKILL.md'), opts.body, 'utf-8');
  if (opts.marker !== undefined) await writeFile(join(dst, INSTALL_MARKER_FILENAME), opts.marker, 'utf-8');
  if (opts.extraFile !== undefined) await writeFile(join(dst, opts.extraFile), 'stray', 'utf-8');
  return dst;
};

const markerHeldBy = (pid: number): string => JSON.stringify({ installedBy: 'ralphctl', skill: NAME, pid });

const readMarker = async (dst: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(dst, INSTALL_MARKER_FILENAME), 'utf-8')) as Record<string, unknown>;

describe('createFilesystemSkillsAdapter — install ownership marker', () => {
  it('stamps each installed folder with a marker naming this process, and uninstall removes both', async () => {
    const session = await makeSession();
    const adapter = newAdapter();

    expect((await adapter.install(session, [skill('# A')])).ok).toBe(true);
    const marker = await readMarker(skillDir(session));
    expect(marker).toMatchObject({ skill: NAME, pid: process.pid });

    expect((await adapter.uninstall(session)).ok).toBe(true);
    expect(existsSync(skillDir(session))).toBe(false);
  });

  it('refreshes a folder left behind by a run that is no longer alive, and reclaims it on uninstall', async () => {
    const session = await makeSession();
    const dst = await plantFolder(session, {
      body: '# v1 from a crashed run',
      marker: markerHeldBy(DEAD_PID),
      extraFile: 'leftover.txt',
    });

    const adapter = newAdapter();
    expect((await adapter.install(session, [skill('# v2 current')])).ok).toBe(true);

    const content = await readFile(join(dst, 'SKILL.md'), 'utf-8');
    expect(content).toContain('# v2 current');
    expect(content).not.toContain('v1 from a crashed run');
    // Replaced wholesale, not merged into, and re-stamped as held by this process.
    expect(existsSync(join(dst, 'leftover.txt'))).toBe(false);
    expect(await readMarker(dst)).toMatchObject({ pid: process.pid });

    await adapter.uninstall(session);
    expect(existsSync(dst)).toBe(false);
  });

  it.each([
    ['an empty body (a write cut short)', ''],
    ['a body that is not JSON', 'not json'],
    ['a missing pid', JSON.stringify({ installedBy: 'ralphctl' })],
    ['a non-numeric pid', JSON.stringify({ pid: String(process.pid) })],
    ['a negative pid', JSON.stringify({ pid: -1 })],
    ['a fractional pid', JSON.stringify({ pid: 1.5 })],
    ['a pid beyond the int32 range', JSON.stringify({ pid: 4_294_967_296 })],
  ])('treats a marker with %s as a stale leftover', async (_label, marker) => {
    const session = await makeSession();
    const dst = await plantFolder(session, { body: '# stale', marker });

    expect((await newAdapter().install(session, [skill('# fresh')])).ok).toBe(true);

    expect(await readFile(join(dst, 'SKILL.md'), 'utf-8')).toContain('# fresh');
    expect(await readMarker(dst)).toMatchObject({ pid: process.pid });
  });

  it('leaves a folder alone while the run that installed it is still alive', async () => {
    const session = await makeSession();
    // The test runner's parent process outlives this test, so it stands in for another live run.
    const dst = await plantFolder(session, { body: '# held by a live run', marker: markerHeldBy(process.ppid) });

    const adapter = newAdapter();
    expect((await adapter.install(session, [skill('# would clobber')])).ok).toBe(true);
    expect(await readFile(join(dst, 'SKILL.md'), 'utf-8')).toBe('# held by a live run');
    expect(await readMarker(dst)).toMatchObject({ pid: process.ppid });

    // Not tracked, so this run's uninstall leaves the other run's copy in place.
    await adapter.uninstall(session);
    expect(existsSync(join(dst, 'SKILL.md'))).toBe(true);
  });

  it('does not clobber a concurrent launch in the same process, and only the installer removes it', async () => {
    const session = await makeSession();
    const first = newAdapter();
    const second = newAdapter();

    await first.install(session, [skill('# first launch')]);
    await second.install(session, [skill('# second launch')]);
    expect(await readFile(join(skillDir(session), 'SKILL.md'), 'utf-8')).toContain('# first launch');

    await second.uninstall(session);
    expect(existsSync(skillDir(session))).toBe(true);

    await first.uninstall(session);
    expect(existsSync(skillDir(session))).toBe(false);
  });

  it('leaves an unmarked project copy untouched and untracked', async () => {
    const session = await makeSession();
    const dst = await plantFolder(session, { body: 'PROJECT AUTHORED' });

    const adapter = newAdapter();
    expect((await adapter.install(session, [skill('# bundled')])).ok).toBe(true);
    expect(await readFile(join(dst, 'SKILL.md'), 'utf-8')).toBe('PROJECT AUTHORED');
    expect(existsSync(join(dst, INSTALL_MARKER_FILENAME))).toBe(false);

    await adapter.uninstall(session);
    expect(existsSync(join(dst, 'SKILL.md'))).toBe(true);
  });

  it('keeps its own copy on a repeated install in the same run', async () => {
    const session = await makeSession();
    const adapter = newAdapter();

    await adapter.install(session, [skill('# v1')]);
    await adapter.install(session, [skill('# v2 should not overwrite')]);

    const content = await readFile(join(skillDir(session), 'SKILL.md'), 'utf-8');
    expect(content).toContain('# v1');
    expect(content).not.toContain('v2 should not overwrite');
  });

  it('rewrites its own tracked copy when the folder vanished mid-run', async () => {
    const session = await makeSession();
    const adapter = newAdapter();

    await adapter.install(session, [skill('# v1')]);
    await rm(skillDir(session), { recursive: true, force: true });
    await adapter.install(session, [skill('# v1')]);

    expect(existsSync(join(skillDir(session), 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillDir(session), INSTALL_MARKER_FILENAME))).toBe(true);
  });
});

describe('createFilesystemSkillsAdapter — unmarked shadow warning', () => {
  it('warns once per folder when an unmarked copy differs from the skill being installed', async () => {
    const { logger, warnings } = recordingLogger();
    const adapter = newAdapter(logger);
    const sessionA = await makeSession();
    const sessionB = await makeSession();
    const dstA = await plantFolder(sessionA, { body: 'old rendered text' });
    await plantFolder(sessionB, { body: 'old rendered text' });

    await adapter.install(sessionA, [skill('# current')]);
    await adapter.install(sessionA, [skill('# current')]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(dstA);
    expect(warnings[0]).toContain(NAME);

    await adapter.install(sessionB, [skill('# current')]);
    expect(warnings).toHaveLength(2);
  });

  it('stays quiet when the unmarked copy already matches the skill being installed', async () => {
    const { logger, warnings } = recordingLogger();
    const session = await makeSession();
    // Produce the exact rendering, then strip the marker so it reads as an unmarked copy.
    await newAdapter().install(session, [skill('# same')]);
    await rm(join(skillDir(session), INSTALL_MARKER_FILENAME));

    await newAdapter(logger).install(session, [skill('# same')]);
    expect(warnings).toEqual([]);
  });

  it('stays quiet for a folder held by a live run', async () => {
    const { logger, warnings } = recordingLogger();
    const session = await makeSession();
    await plantFolder(session, { body: '# other version', marker: markerHeldBy(process.ppid) });

    await newAdapter(logger).install(session, [skill('# current')]);
    expect(warnings).toEqual([]);
  });
});

describe('createFilesystemSkillsAdapter — stale-replacement logging', () => {
  it('logs the dead pid before deleting a stale-marked folder', async () => {
    const { logger, infos } = recordingLogger();
    const session = await makeSession();
    const dst = await plantFolder(session, { body: '# v1 from a crashed run', marker: markerHeldBy(DEAD_PID) });

    await newAdapter(logger).install(session, [skill('# v2 current')]);

    expect(infos).toHaveLength(1);
    expect(infos[0]?.message).toContain(dst);
    expect(infos[0]?.message).toContain(NAME);
    expect(infos[0]?.message).toContain(String(DEAD_PID));
    expect(infos[0]?.meta).toMatchObject({ path: dst, skill: NAME, deadPid: DEAD_PID });
  });

  it('still logs the replacement, without a pid, when the marker is unparseable', async () => {
    const { logger, infos } = recordingLogger();
    const session = await makeSession();
    await plantFolder(session, { body: '# stale', marker: 'not json' });

    await newAdapter(logger).install(session, [skill('# fresh')]);

    expect(infos).toHaveLength(1);
    expect(infos[0]?.meta).not.toHaveProperty('deadPid');
  });

  it('says nothing when the destination is untouched or held by a live run', async () => {
    const { logger, infos } = recordingLogger();
    const session = await makeSession();
    await newAdapter(logger).install(session, [skill('# fresh install')]);
    expect(infos).toEqual([]);

    const liveSession = await makeSession();
    await plantFolder(liveSession, { body: '# held by a live run', marker: markerHeldBy(process.ppid) });
    await newAdapter(logger).install(liveSession, [skill('# would clobber')]);
    expect(infos).toEqual([]);
  });
});
