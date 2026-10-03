import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as FsPromises from 'node:fs/promises';
import type { RunCommand, RunCommandOptions, RunCommandResult } from '@src/integration/io/run-command.ts';

const readFile = vi.hoisted(() => vi.fn<(path: string, encoding: string) => Promise<string>>());
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  readFile,
}));

const { createProcessLiveness, readMachineId } = await import('@src/integration/io/process-liveness.ts');

interface Call {
  readonly name: string;
  readonly args: readonly string[];
  readonly opts?: RunCommandOptions;
}

const fakeRun = (result: Partial<RunCommandResult>): { readonly run: RunCommand; readonly calls: Call[] } => {
  const calls: Call[] = [];
  return {
    calls,
    run: (name, args, opts) => {
      calls.push({ name, args, ...(opts !== undefined ? { opts } : {}) });
      return Promise.resolve({ ok: true, code: 0, stdout: '', stderr: '', ...result });
    },
  };
};

const originalPlatform = process.platform;
const onPlatform = (platform: NodeJS.Platform): void => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
};

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  readFile.mockReset();
});

describe('createProcessLiveness().identify', () => {
  it('runs ps in the C locale and splits the five-field start time from the command', async () => {
    onPlatform('darwin');
    const { run, calls } = fakeRun({ stdout: 'Fri Oct  2 07:40:35 2026     /usr/local/bin/claude --print\n' });

    const identity = await createProcessLiveness({ runCommand: run }).identify(4242);

    expect(identity).toEqual({ startedAt: 'Fri Oct 2 07:40:35 2026', command: '/usr/local/bin/claude --print' });
    expect(calls).toEqual([
      { name: 'ps', args: ['-o', 'lstart=', '-o', 'comm=', '-p', '4242'], opts: { env: { LC_ALL: 'C', TZ: 'UTC' } } },
    ]);
  });

  it('resolves undefined for output it cannot parse, a failed ps, a bad pid, or Windows', async () => {
    onPlatform('linux');
    const localized = fakeRun({ stdout: 'Fr.  2 Okt. 07:40:35 2026 claude\n' });
    expect(await createProcessLiveness({ runCommand: localized.run }).identify(4242)).toBeUndefined();

    const failed = fakeRun({ ok: false, code: 1 });
    expect(await createProcessLiveness({ runCommand: failed.run }).identify(4242)).toBeUndefined();

    const unused = fakeRun({ stdout: 'Fri Oct  2 07:40:35 2026 claude' });
    expect(await createProcessLiveness({ runCommand: unused.run }).identify(0)).toBeUndefined();
    onPlatform('win32');
    expect(await createProcessLiveness({ runCommand: unused.run }).identify(4242)).toBeUndefined();
    expect(unused.calls).toEqual([]);
  });
});

describe('readMachineId', () => {
  it('reads the IOPlatformUUID from ioreg on macOS', async () => {
    onPlatform('darwin');
    const { run, calls } = fakeRun({ stdout: '  "IOPlatformUUID" = "1234-ABCD"\n  "other" = "x"\n' });
    expect(await readMachineId(run)).toBe('1234-ABCD');
    expect(calls[0]?.name).toBe('ioreg');
  });

  it('resolves undefined when ioreg fails or prints no UUID', async () => {
    onPlatform('darwin');
    expect(await readMachineId(fakeRun({ ok: false, code: 1 }).run)).toBeUndefined();
    expect(await readMachineId(fakeRun({ stdout: 'nothing here' }).run)).toBeUndefined();
  });

  it('reads the first non-empty machine-id file on Linux', async () => {
    onPlatform('linux');
    readFile.mockImplementation((path) =>
      path === '/etc/machine-id' ? Promise.reject(new Error('ENOENT')) : Promise.resolve('  abc123\n')
    );
    expect(await readMachineId(fakeRun({}).run)).toBe('abc123');

    readFile.mockResolvedValue('\n');
    expect(await readMachineId(fakeRun({}).run)).toBeUndefined();
  });

  it('resolves undefined on Windows without probing', async () => {
    onPlatform('win32');
    const { run, calls } = fakeRun({});
    expect(await readMachineId(run)).toBeUndefined();
    expect(calls).toEqual([]);
  });
});
