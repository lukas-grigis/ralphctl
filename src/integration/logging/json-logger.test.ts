/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { JsonLogger } from './json-logger.ts';

const ORIGINAL_LEVEL = process.env['RALPHCTL_LOG_LEVEL'];
const ORIGINAL_VITEST = process.env['VITEST'];

const FIXED_NOW = IsoTimestamp.trustString('2026-04-29T00:00:00.000Z');

interface Captured {
  out: string[];
  err: string[];
  push: (line: string) => void;
  pushErr: (line: string) => void;
}

function capture(): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    push: (line) => out.push(line),
    pushErr: (line) => err.push(line),
  };
}

describe('JsonLogger', () => {
  beforeEach(() => {
    delete process.env['VITEST'];
    delete process.env['RALPHCTL_LOG_LEVEL'];
  });
  afterEach(() => {
    if (ORIGINAL_VITEST !== undefined) process.env['VITEST'] = ORIGINAL_VITEST;
    if (ORIGINAL_LEVEL !== undefined) process.env['RALPHCTL_LOG_LEVEL'] = ORIGINAL_LEVEL;
  });

  it('emits one JSON object per call with level, message, timestamp', () => {
    const c = capture();
    const sink = new JsonLogger({
      level: 'debug',
      stdout: c.push,
      stderr: c.pushErr,
      now: () => FIXED_NOW,
    });
    sink.info('hello');
    expect(c.out).toHaveLength(1);
    const obj = JSON.parse(c.out[0]!) as Record<string, unknown>;
    expect(obj['level']).toBe('info');
    expect(obj['message']).toBe('hello');
    expect(obj['timestamp']).toBe(FIXED_NOW);
  });

  it('emits success records with level: "success" on stdout', () => {
    const c = capture();
    const sink = new JsonLogger({
      level: 'debug',
      stdout: c.push,
      stderr: c.pushErr,
      now: () => FIXED_NOW,
    });
    sink.success('task done');
    expect(c.out).toHaveLength(1);
    expect(c.err).toHaveLength(0);
    const obj = JSON.parse(c.out[0]!) as Record<string, unknown>;
    expect(obj['level']).toBe('success');
    expect(obj['message']).toBe('task done');
  });

  it('treats success as info-tier — suppressed at warn level', () => {
    const c = capture();
    const sink = new JsonLogger({
      level: 'warn',
      stdout: c.push,
      stderr: c.pushErr,
      now: () => FIXED_NOW,
    });
    sink.success('milestone');
    expect(c.out).toHaveLength(0);
    expect(c.err).toHaveLength(0);
  });

  it('routes warn/error to stderr', () => {
    const c = capture();
    const sink = new JsonLogger({
      level: 'debug',
      stdout: c.push,
      stderr: c.pushErr,
      now: () => FIXED_NOW,
    });
    sink.warn('w');
    sink.error('e');
    expect(c.out).toHaveLength(0);
    expect(c.err).toHaveLength(2);
    expect((JSON.parse(c.err[0]!) as Record<string, unknown>)['level']).toBe('warn');
    expect((JSON.parse(c.err[1]!) as Record<string, unknown>)['level']).toBe('error');
  });

  it('merges context from constructor + child + per-call', () => {
    const c = capture();
    const root = new JsonLogger({
      level: 'debug',
      stdout: c.push,
      stderr: c.pushErr,
      now: () => FIXED_NOW,
      context: { app: 'ralphctl' },
    });
    const child = root.child({ sprintId: 'abc' });
    child.info('msg', { taskId: 'def' });

    const obj = JSON.parse(c.out[0]!) as Record<string, unknown>;
    expect(obj['app']).toBe('ralphctl');
    expect(obj['sprintId']).toBe('abc');
    expect(obj['taskId']).toBe('def');
  });

  it('per-call context overrides bound context for the same key', () => {
    const c = capture();
    const sink = new JsonLogger({
      level: 'debug',
      stdout: c.push,
      stderr: c.pushErr,
      now: () => FIXED_NOW,
      context: { tag: 'old' },
    });
    sink.info('m', { tag: 'new' });
    const obj = JSON.parse(c.out[0]!) as Record<string, unknown>;
    expect(obj['tag']).toBe('new');
  });

  it('filters below the configured level', () => {
    const c = capture();
    const sink = new JsonLogger({
      level: 'warn',
      stdout: c.push,
      stderr: c.pushErr,
      now: () => FIXED_NOW,
    });
    sink.debug('d');
    sink.info('i');
    sink.warn('w');
    expect(c.out).toHaveLength(0);
    expect(c.err).toHaveLength(1);
  });

  it('respects RALPHCTL_LOG_LEVEL env var when level is omitted', () => {
    process.env['RALPHCTL_LOG_LEVEL'] = 'error';
    const c = capture();
    const sink = new JsonLogger({ stdout: c.push, stderr: c.pushErr, now: () => FIXED_NOW });
    sink.warn('skip');
    sink.error('show');
    expect(c.err).toHaveLength(1);
  });

  it('silences info/warn under VITEST=1 by default', () => {
    process.env['VITEST'] = '1';
    const c = capture();
    const sink = new JsonLogger({ stdout: c.push, stderr: c.pushErr, now: () => FIXED_NOW });
    sink.info('skip');
    sink.warn('also');
    sink.error('show');
    expect(c.out).toHaveLength(0);
    expect(c.err).toHaveLength(1);
  });

  it('time() emits a debug record with ms', () => {
    const c = capture();
    const sink = new JsonLogger({
      level: 'debug',
      stdout: c.push,
      stderr: c.pushErr,
      now: () => FIXED_NOW,
    });
    const stop = sink.time('plan');
    stop();
    expect(c.out).toHaveLength(1);
    const obj = JSON.parse(c.out[0]!) as Record<string, unknown>;
    expect(obj['level']).toBe('debug');
    expect(obj['message']).toBe('plan');
    expect(typeof obj['ms']).toBe('number');
  });
});
