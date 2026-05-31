import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import type { ChangeSignal, CommitMessageSignal } from '@src/domain/signal.ts';
import { renderSidecars } from '@src/integration/ai/contract/_engine/render-sidecars.ts';
import type { SidecarRule } from '@src/integration/ai/contract/_engine/types.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';

const path = (p: string): AbsolutePath => {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error(`bad: ${p}`);
  return r.value;
};

const ts = (): IsoTimestamp => {
  const r = IsoTimestamp.parse('2026-05-22T10:00:00.000Z');
  if (!r.ok) throw new Error('bad ts');
  return r.value;
};

interface RecordingWriteFile {
  readonly writeFile: WriteFile;
  readonly writes: Array<{ path: AbsolutePath; body: string }>;
}

const recordingWriteFile = (): RecordingWriteFile => {
  const writes: Array<{ path: AbsolutePath; body: string }> = [];
  const writeFile: WriteFile = async (p, content) => {
    writes.push({ path: p, body: content });
    return Result.ok(undefined);
  };
  return { writeFile, writes };
};

describe('renderSidecars', () => {
  it('writes one file per matching signal under optional multiplicity', async () => {
    const signals: readonly CommitMessageSignal[] = [
      { type: 'commit-message', subject: 'feat: thing', body: 'body line', timestamp: ts() },
    ];
    const rules: ReadonlyArray<SidecarRule<'commit-message'>> = [
      {
        signalKind: 'commit-message',
        filename: 'commit-message.txt',
        multiplicity: 'optional',
        extract: (s) => (s.body !== undefined && s.body.length > 0 ? `${s.subject}\n\n${s.body}\n` : `${s.subject}\n`),
      },
    ];
    const recording = recordingWriteFile();

    const result = await renderSidecars(recording.writeFile, path('/tmp/output'), signals, rules, noopLogger);
    if (!result.ok) throw new Error('expected ok');
    expect(recording.writes).toHaveLength(1);
    expect(String(recording.writes[0]?.path)).toBe('/tmp/output/commit-message.txt');
    expect(recording.writes[0]?.body).toBe('feat: thing\n\nbody line\n');
  });

  it('skips an optional sidecar when no matching signal is present', async () => {
    const signals: ReadonlyArray<ChangeSignal | CommitMessageSignal> = [
      { type: 'change', text: 'something', timestamp: ts() },
    ];
    const rules: ReadonlyArray<SidecarRule<'change' | 'commit-message'>> = [
      {
        signalKind: 'commit-message',
        filename: 'commit-message.txt',
        multiplicity: 'optional',
        extract: (s) => (s as CommitMessageSignal).subject,
      },
    ];
    const recording = recordingWriteFile();

    const result = await renderSidecars(recording.writeFile, path('/tmp/output'), signals, rules, noopLogger);
    if (!result.ok) throw new Error('expected ok');
    expect(recording.writes).toHaveLength(0);
  });

  it('returns Result.ok even when WriteFile fails (sidecars are operator-UX only)', async () => {
    const signals: readonly CommitMessageSignal[] = [{ type: 'commit-message', subject: 's', timestamp: ts() }];
    const rules: ReadonlyArray<SidecarRule<'commit-message'>> = [
      {
        signalKind: 'commit-message',
        filename: 'commit-message.txt',
        multiplicity: 'optional',
        extract: (s) => s.subject,
      },
    ];
    let warnCalls = 0;
    const failingWriteFile: WriteFile = async () => Result.error({ subCode: 'io', message: 'disk full' } as never);
    const result = await renderSidecars(failingWriteFile, path('/tmp/output'), signals, rules, {
      ...noopLogger,
      warn() {
        warnCalls += 1;
      },
    });
    expect(result.ok).toBe(true);
    expect(warnCalls).toBe(1);
  });
});
