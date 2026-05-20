import { describe, expect, it, vi } from 'vitest';
import { createOsNotificationDispatcher } from '@src/integration/observability/os-notification-dispatcher.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';

interface ExecCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly timeout: number;
}

const makeHarness = (opts: {
  readonly platform: NodeJS.Platform;
  readonly execResults?: ReadonlyMap<string, { readonly stdout: string; readonly stderr: string } | Error>;
}) => {
  const calls: ExecCall[] = [];
  const bellCalls: { count: number } = { count: 0 };
  const execFile = async (command: string, args: readonly string[], options: { readonly timeout: number }) => {
    calls.push({ command, args, timeout: options.timeout });
    const result = opts.execResults?.get(command);
    if (result instanceof Error) throw result;
    return result ?? { stdout: '', stderr: '' };
  };
  const dispatcher = createOsNotificationDispatcher({
    logger: noopLogger,
    platform: () => opts.platform,
    execFile,
    emitBell: () => {
      bellCalls.count += 1;
    },
  });
  return { dispatcher, calls, bellCalls };
};

describe('createOsNotificationDispatcher — Darwin', () => {
  it("invokes `osascript -e 'display notification ... with title ...'` with the title and body", async () => {
    const h = makeHarness({ platform: 'darwin' });
    await h.dispatcher.notify('attention', 'Pre-check red', '/repos/app');
    expect(h.calls).toEqual([
      {
        command: 'osascript',
        args: ['-e', 'display notification "/repos/app" with title "Pre-check red"'],
        timeout: 5_000,
      },
    ]);
    expect(h.bellCalls.count).toBe(1);
  });

  it('escapes embedded double-quotes and backslashes for the AppleScript parser', async () => {
    const h = makeHarness({ platform: 'darwin' });
    await h.dispatcher.notify('failure', 'ralphctl aborted', 'cause: "explosion" \\ retry');
    expect(h.calls).toHaveLength(1);
    const argv = h.calls[0]!.args.join(' ');
    expect(argv).toContain('with title "ralphctl aborted"');
    // body should have \" and \\ escaped:
    expect(argv).toContain('"cause: \\"explosion\\" \\\\ retry"');
  });

  it('replaces embedded newlines with a space (AppleScript double-quoted literals cannot span lines)', async () => {
    const h = makeHarness({ platform: 'darwin' });
    await h.dispatcher.notify('attention', 'line one\nline two', 'body\nwith\nbreaks');
    expect(h.calls[0]!.args[1]).toBe('display notification "body with breaks" with title "line one line two"');
  });

  it('omits the body cleanly when caller passes no body', async () => {
    const h = makeHarness({ platform: 'darwin' });
    await h.dispatcher.notify('paused', 'ralphctl paused');
    // Body is the empty string in the AppleScript literal — caller intentionally provided none.
    expect(h.calls[0]!.args[1]).toBe('display notification "" with title "ralphctl paused"');
    expect(h.bellCalls.count).toBe(1);
  });

  it('absorbs an osascript failure — the dispatcher promise still resolves and the bell still fires', async () => {
    const h = makeHarness({
      platform: 'darwin',
      execResults: new Map([['osascript', new Error('osascript died')]]),
    });
    await expect(h.dispatcher.notify('failure', 'ralphctl aborted', 'SIGTERM')).resolves.toBeUndefined();
    expect(h.bellCalls.count).toBe(1);
  });
});

describe('createOsNotificationDispatcher — Linux', () => {
  it('probes for notify-send via `which`, then invokes it with title + body', async () => {
    const h = makeHarness({ platform: 'linux' });
    await h.dispatcher.notify('attention', 'Pre-check red', '/repos/app');
    expect(h.calls.map((c) => c.command)).toEqual(['which', 'notify-send']);
    expect(h.calls[1]!.args).toEqual(['Pre-check red', '/repos/app']);
    expect(h.bellCalls.count).toBe(1);
  });

  it('skips silently when `which notify-send` exits non-zero (binary missing)', async () => {
    const h = makeHarness({
      platform: 'linux',
      execResults: new Map([['which', new Error('not found')]]),
    });
    await h.dispatcher.notify('attention', 't', 'b');
    expect(h.calls.map((c) => c.command)).toEqual(['which']);
    // Bell still fires — the floor cross-platform signal.
    expect(h.bellCalls.count).toBe(1);
  });

  it('omits the body argv slot when caller passes no body', async () => {
    const h = makeHarness({ platform: 'linux' });
    await h.dispatcher.notify('paused', 'ralphctl paused');
    expect(h.calls[1]!.args).toEqual(['ralphctl paused']);
  });
});

describe('createOsNotificationDispatcher — unsupported platforms', () => {
  it('rings the bell on win32 but skips the OS shell-out', async () => {
    const h = makeHarness({ platform: 'win32' });
    await h.dispatcher.notify('attention', 'Pre-check red', 'body');
    expect(h.calls).toEqual([]);
    expect(h.bellCalls.count).toBe(1);
  });

  it('rings the bell on freebsd / other unknown platforms too', async () => {
    const h = makeHarness({ platform: 'freebsd' as NodeJS.Platform });
    await h.dispatcher.notify('failure', 'ralphctl aborted', 'SIGTERM');
    expect(h.calls).toEqual([]);
    expect(h.bellCalls.count).toBe(1);
  });
});

describe('createOsNotificationDispatcher — defaults', () => {
  it('production default writes the bell character to process.stdout', async () => {
    // Inject only the execFile + platform; let `emitBell` default to its production impl
    // so the test exercises the `process.stdout.write('\\x07')` path.
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const dispatcher = createOsNotificationDispatcher({
      logger: noopLogger,
      platform: () => 'win32', // skips OS shell-out — we only care about the bell here
      execFile: async () => ({ stdout: '', stderr: '' }),
    });
    await dispatcher.notify('attention', 't', 'b');
    expect(writeSpy).toHaveBeenCalledWith('\x07');
    writeSpy.mockRestore();
  });
});
