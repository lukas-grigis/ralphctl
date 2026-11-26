import { describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { createEventBusLogger } from '@src/business/observability/event-bus-logger.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { createAtomicWriteFile } from '@src/integration/io/write-file-atomic.ts';
import { loadSkillFolders } from '@src/integration/ai/skills/_engine/skill-folder-loader.ts';
import { createCopilotSkillsAdapter } from '@src/integration/ai/skills/copilot/adapter.ts';
import { createSkillCatalog } from '@src/integration/ai/skills/phase/catalog.ts';
import { PHASE_FLOW_DIR } from '@src/integration/ai/skills/phase/source.ts';

// Spec-valid skill folders carry binary assets and executable scripts. Neither may make the
// folder unloadable, and both must survive install byte-for-byte (scripts stay executable).

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x01]);
const posix = process.platform !== 'win32';

const abs = (p: string): AbsolutePath => {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error(`bad path: ${p}`);
  return r.value;
};

const logger = () => createEventBusLogger({ eventBus: createInMemoryEventBus(), clock: IsoTimestamp.now });

const seedFolder = async (dir: string, name: string): Promise<void> => {
  await mkdir(join(dir, 'assets'), { recursive: true });
  await mkdir(join(dir, 'scripts'), { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} guidance\n---\n\nRun ./scripts/x.sh\n`
  );
  await writeFile(join(dir, 'assets', 'logo.png'), PNG);
  await writeFile(join(dir, 'scripts', 'x.sh'), '#!/bin/sh\necho hi\n');
  await chmod(join(dir, 'scripts', 'x.sh'), 0o755);
};

describe('skill support files — binary assets and executable scripts', () => {
  it('loads a folder with a binary asset and installs it byte-identical, script still executable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'support-bytes-'));
    await seedFolder(join(root, 'foo'), 'foo');

    const skills = await loadSkillFolders({ root, label: 'operator skill', log: logger(), logFields: {} });
    expect(skills.map((s) => s.name)).toEqual(['ralphctl-foo']);

    const session = await mkdtemp(join(tmpdir(), 'support-bytes-session-'));
    const installed = await createCopilotSkillsAdapter().install(abs(session), skills);
    expect(installed.ok).toBe(true);
    const dst = join(session, '.github/skills/ralphctl-foo');
    expect(new Uint8Array(await readFile(join(dst, 'assets', 'logo.png')))).toEqual(PNG);
    expect(await readFile(join(dst, 'scripts', 'x.sh'), 'utf-8')).toBe('#!/bin/sh\necho hi\n');
    if (posix) expect((await stat(join(dst, 'scripts', 'x.sh'))).mode & 0o111).not.toBe(0);
  });

  it('catalog list() survives a manual phase folder with a binary asset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'support-bytes-catalog-'));
    await seedFolder(join(root, PHASE_FLOW_DIR.plan, 'my-own'), 'my-own');
    const catalog = createSkillCatalog({
      operatorSkillsRoot: abs(root),
      writeFile: createAtomicWriteFile(),
      bundledRawReader: {
        readFolder: async (name) => Result.ok({ skillMd: `---\nname: ${name}\ndescription: d\n---\n`, files: [] }),
      },
      logger: logger(),
    });

    const listed = await catalog.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.find((e) => e.name === 'my-own')?.installs).toEqual([{ flow: 'plan', status: 'manual' }]);
  });

  it('catalog list() degrades an unreadable support folder to a broken row instead of failing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'support-bytes-catalog-'));
    const dir = join(root, PHASE_FLOW_DIR.plan, 'too-big');
    await mkdir(join(dir, 'assets'), { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), '---\nname: too-big\ndescription: d\n---\n');
    await writeFile(join(dir, 'assets', 'blob.bin'), new Uint8Array(5 * 1024 * 1024));
    const catalog = createSkillCatalog({
      operatorSkillsRoot: abs(root),
      writeFile: createAtomicWriteFile(),
      bundledRawReader: {
        readFolder: async (name) => Result.ok({ skillMd: `---\nname: ${name}\ndescription: d\n---\n`, files: [] }),
      },
      logger: logger(),
    });

    const listed = await catalog.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.find((e) => e.name === 'too-big')?.installs).toEqual([{ flow: 'plan', status: 'broken' }]);
  });
});
