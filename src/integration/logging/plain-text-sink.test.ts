import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PlainTextSink } from './plain-text-sink.ts';

const ORIGINAL_LEVEL = process.env['RALPHCTL_LOG_LEVEL'];
const ORIGINAL_VITEST = process.env['VITEST'];

interface Captured {
  out: string[];
  err: string[];
}

function capture(): Captured & {
  push: (line: string) => void;
  pushErr: (line: string) => void;
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    push: (line: string) => out.push(line),
    pushErr: (line: string) => err.push(line),
  };
}

describe('PlainTextSink', () => {
  beforeEach(() => {
    delete process.env['VITEST'];
    delete process.env['RALPHCTL_LOG_LEVEL'];
  });
  afterEach(() => {
    if (ORIGINAL_VITEST !== undefined) process.env['VITEST'] = ORIGINAL_VITEST;
    if (ORIGINAL_LEVEL !== undefined) process.env['RALPHCTL_LOG_LEVEL'] = ORIGINAL_LEVEL;
  });

  it('writes info to stdout and warn/error to stderr', () => {
    const c = capture();
    const sink = new PlainTextSink({ level: 'debug', stdout: c.push, stderr: c.pushErr });

    sink.info('hello');
    sink.warn('careful');
    sink.error('bad');

    expect(c.out.some((l) => l.includes('hello'))).toBe(true);
    expect(c.err.some((l) => l.includes('careful'))).toBe(true);
    expect(c.err.some((l) => l.includes('bad'))).toBe(true);
  });

  it('writes success() to stdout with a distinct [ok] prefix', () => {
    const c = capture();
    const sink = new PlainTextSink({ level: 'debug', stdout: c.push, stderr: c.pushErr });

    sink.success('task done');

    expect(c.out).toHaveLength(1);
    // The prefix is what makes a success line visibly distinct from an
    // info line in the recent-events panel. colorette strips ANSI under
    // non-TTY (test runners pipe stdout) so we lock the prefix label
    // rather than the green start-code; the prefix carries the visible
    // distinction even when colors are stripped.
    expect(c.out[0]).toMatch(/\[ok\]\s+task done/);
    // Routes to stdout, not stderr (success is info-tier).
    expect(c.err).toHaveLength(0);
  });

  it('treats success as info-tier for filtering — shown at info, suppressed at warn', () => {
    const cInfo = capture();
    const sinkInfo = new PlainTextSink({ level: 'info', stdout: cInfo.push, stderr: cInfo.pushErr });
    sinkInfo.success('milestone');
    expect(cInfo.out.some((l) => l.includes('milestone'))).toBe(true);

    const cWarn = capture();
    const sinkWarn = new PlainTextSink({ level: 'warn', stdout: cWarn.push, stderr: cWarn.pushErr });
    sinkWarn.success('milestone');
    expect(cWarn.out).toHaveLength(0);
    expect(cWarn.err).toHaveLength(0);
  });

  it('filters debug below info level', () => {
    const c = capture();
    const sink = new PlainTextSink({ level: 'info', stdout: c.push, stderr: c.pushErr });
    sink.debug('hidden');
    sink.info('shown');
    expect(c.out.some((l) => l.includes('hidden'))).toBe(false);
    expect(c.out.some((l) => l.includes('shown'))).toBe(true);
  });

  it('filters info+warn at error level', () => {
    const c = capture();
    const sink = new PlainTextSink({ level: 'error', stdout: c.push, stderr: c.pushErr });
    sink.info('x');
    sink.warn('y');
    sink.error('z');
    expect(c.out).toHaveLength(0);
    expect(c.err.some((l) => l.includes('y'))).toBe(false);
    expect(c.err.some((l) => l.includes('z'))).toBe(true);
  });

  it('respects RALPHCTL_LOG_LEVEL when no explicit level is given', () => {
    process.env['RALPHCTL_LOG_LEVEL'] = 'warn';
    const c = capture();
    const sink = new PlainTextSink({ stdout: c.push, stderr: c.pushErr });
    sink.info('skipped');
    sink.warn('kept');
    expect(c.out).toHaveLength(0);
    expect(c.err.some((l) => l.includes('kept'))).toBe(true);
  });

  it('silences info/warn under VITEST=1 by default', () => {
    process.env['VITEST'] = '1';
    const c = capture();
    const sink = new PlainTextSink({ stdout: c.push, stderr: c.pushErr });
    sink.info('skipped');
    sink.warn('also skipped');
    sink.error('shown');
    expect(c.out).toHaveLength(0);
    expect(c.err.some((l) => l.includes('shown'))).toBe(true);
    expect(c.err.some((l) => l.includes('also skipped'))).toBe(false);
  });

  it('child() merges context into every log line', () => {
    const c = capture();
    const root = new PlainTextSink({
      level: 'debug',
      stdout: c.push,
      stderr: c.pushErr,
      context: { app: 'ralphctl' },
    });
    const child = root.child({ sprintId: '20260429-120000-x' });
    child.info('hi');
    expect(c.out[0]).toContain('app=ralphctl');
    expect(c.out[0]).toContain('sprintId=20260429-120000-x');
  });

  it('child() stacks context across multiple .child() calls', () => {
    const c = capture();
    const a = new PlainTextSink({ level: 'debug', stdout: c.push, stderr: c.pushErr }).child({
      a: 1,
    });
    const b = a.child({ b: 2 });
    b.info('msg');
    expect(c.out[0]).toContain('a=1');
    expect(c.out[0]).toContain('b=2');
  });

  it('time() logs elapsed ms at debug level', () => {
    const c = capture();
    const sink = new PlainTextSink({ level: 'debug', stdout: c.push, stderr: c.pushErr });
    const stop = sink.time('plan');
    stop();
    expect(c.out.some((l) => l.includes('plan') && l.includes('ms='))).toBe(true);
  });

  it('time() output is suppressed when level is above debug', () => {
    const c = capture();
    const sink = new PlainTextSink({ level: 'info', stdout: c.push, stderr: c.pushErr });
    const stop = sink.time('plan');
    stop();
    expect(c.out).toHaveLength(0);
  });

  it('falls back to process.stdout.write when no override is provided', () => {
    const writeOut = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const writeErr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const sink = new PlainTextSink({ level: 'debug' });
    sink.info('x');
    sink.error('y');
    expect(writeOut).toHaveBeenCalled();
    expect(writeErr).toHaveBeenCalled();
    writeOut.mockRestore();
    writeErr.mockRestore();
  });
});
