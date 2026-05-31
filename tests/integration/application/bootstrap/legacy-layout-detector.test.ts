import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectLegacyLayout,
  LEGACY_SKIP_ENV,
  renderLegacyLayoutMessage,
} from '@src/application/bootstrap/legacy-layout-detector.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';

const absolutePath = (p: string): AbsolutePath => {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error(`AbsolutePath.parse failed for ${p}: ${r.error.message}`);
  return r.value;
};

describe('detectLegacyLayout', () => {
  let appRoot: string;

  beforeEach(async () => {
    const raw = await fs.mkdtemp(join(tmpdir(), 'ralphctl-legacy-detector-'));
    appRoot = await fs.realpath(raw);
  });

  afterEach(async () => {
    await fs.rm(appRoot, { recursive: true, force: true });
  });

  it("returns 'fresh' when the appRoot doesn't exist at all", async () => {
    const missingRoot = absolutePath(join(appRoot, 'never-created'));
    const result = await detectLegacyLayout(missingRoot, { env: {} });
    expect(result.kind).toBe('fresh');
  });

  it("returns 'compatible' for an empty appRoot (e.g. a 0.7.0 install before first write)", async () => {
    const result = await detectLegacyLayout(absolutePath(appRoot), { env: {} });
    expect(result.kind).toBe('compatible');
  });

  it("returns 'compatible' for a 0.7.0-shaped appRoot (state/ + config/ + data/, no v0.6.x dirs)", async () => {
    await fs.mkdir(join(appRoot, 'state'), { recursive: true });
    await fs.mkdir(join(appRoot, 'config'), { recursive: true });
    await fs.mkdir(join(appRoot, 'data'), { recursive: true });
    const result = await detectLegacyLayout(absolutePath(appRoot), { env: {} });
    expect(result.kind).toBe('compatible');
  });

  it.each([
    ['cache', 'cache/'],
    ['logs', 'logs/'],
    ['backups', 'backups/'],
  ])('detects %s/ as a v0.6.x signal', async (dirname, expectedSignal) => {
    await fs.mkdir(join(appRoot, dirname), { recursive: true });
    const result = await detectLegacyLayout(absolutePath(appRoot), { env: {} });
    if (result.kind !== 'legacy-v0.6') throw new Error(`expected legacy-v0.6, got ${result.kind}`);
    expect(result.signals).toContain(expectedSignal);
  });

  it('detects top-level config.json as a v0.6.x signal (v0.7.0 puts settings.json under config/)', async () => {
    await fs.writeFile(join(appRoot, 'config.json'), '{"legacy":"data"}');
    const result = await detectLegacyLayout(absolutePath(appRoot), { env: {} });
    if (result.kind !== 'legacy-v0.6') throw new Error(`expected legacy-v0.6, got ${result.kind}`);
    expect(result.signals).toContain('config.json');
  });

  it('reports every matching signal in order, not just the first', async () => {
    await fs.mkdir(join(appRoot, 'cache'), { recursive: true });
    await fs.mkdir(join(appRoot, 'logs'), { recursive: true });
    await fs.writeFile(join(appRoot, 'config.json'), '{}');
    const result = await detectLegacyLayout(absolutePath(appRoot), { env: {} });
    if (result.kind !== 'legacy-v0.6') throw new Error(`expected legacy-v0.6, got ${result.kind}`);
    expect(result.signals).toEqual(['cache/', 'logs/', 'config.json']);
  });

  it("ignores files named like a signal-dir (e.g. a 'cache' regular file is not a v0.6.x signal)", async () => {
    await fs.writeFile(join(appRoot, 'cache'), 'not-a-dir');
    const result = await detectLegacyLayout(absolutePath(appRoot), { env: {} });
    expect(result.kind).toBe('compatible');
  });

  it(`returns 'compatible' when ${LEGACY_SKIP_ENV} is set, even with full v0.6.x signals`, async () => {
    await fs.mkdir(join(appRoot, 'cache'), { recursive: true });
    await fs.mkdir(join(appRoot, 'logs'), { recursive: true });
    await fs.writeFile(join(appRoot, 'config.json'), '{}');
    const result = await detectLegacyLayout(absolutePath(appRoot), { env: { [LEGACY_SKIP_ENV]: '1' } });
    expect(result.kind).toBe('compatible');
  });

  it(`runs detection when ${LEGACY_SKIP_ENV} is set but empty (only truthy values bypass)`, async () => {
    await fs.mkdir(join(appRoot, 'cache'), { recursive: true });
    const result = await detectLegacyLayout(absolutePath(appRoot), { env: { [LEGACY_SKIP_ENV]: '' } });
    expect(result.kind).toBe('legacy-v0.6');
  });
});

describe('renderLegacyLayoutMessage', () => {
  it('produces a backup hint pointing at <appRoot>.0.6-backup', () => {
    const root = absolutePath('/home/alice/.ralphctl');
    const msg = renderLegacyLayoutMessage({ signals: ['cache/'], appRoot: root });
    expect(msg).toContain('mv /home/alice/.ralphctl /home/alice/.ralphctl.0.6-backup');
    expect(msg).toContain('ralphctl');
  });

  it('lists every signal verbatim so the user can sanity-check the detection', () => {
    const root = absolutePath('/home/alice/.ralphctl');
    const msg = renderLegacyLayoutMessage({
      signals: ['cache/', 'logs/', 'config.json'],
      appRoot: root,
    });
    expect(msg).toContain('• cache/');
    expect(msg).toContain('• logs/');
    expect(msg).toContain('• config.json');
  });

  it('surfaces both the RALPHCTL_HOME and the skip-check escape hatches', () => {
    const root = absolutePath('/home/alice/.ralphctl');
    const msg = renderLegacyLayoutMessage({ signals: ['cache/'], appRoot: root });
    expect(msg).toContain('RALPHCTL_HOME=');
    expect(msg).toContain(LEGACY_SKIP_ENV);
  });
});
