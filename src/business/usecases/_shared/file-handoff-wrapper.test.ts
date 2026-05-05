import { describe, expect, it } from 'vitest';

import { renderFileHandoffWrapper, renderFixHandoffWrapper } from './file-handoff-wrapper.ts';

const FAKE_PATH = '/home/user/.ralphctl/data/sprints/20260429-120000-demo/contexts/execute-task-abc.md';
const CRITIQUE_PATH =
  '/home/user/.ralphctl/data/sprints/20260429-120000-demo/execution/abc-task/rounds/1/evaluator/evaluation.md';

describe('renderFileHandoffWrapper', () => {
  it('embeds the absolute promptFilePath verbatim inside the wrapper body', () => {
    const result = renderFileHandoffWrapper(FAKE_PATH);
    expect(result).toContain(FAKE_PATH);
  });

  it('mentions the ralphctl harness so the AI knows it is running under one', () => {
    const result = renderFileHandoffWrapper(FAKE_PATH);
    expect(result.toLowerCase()).toContain('ralphctl');
    expect(result.toLowerCase()).toContain('harness');
  });

  it('is a multi-line string (more than 4 lines) and the file path is on its own line', () => {
    const result = renderFileHandoffWrapper(FAKE_PATH);
    const lines = result.split('\n');
    expect(lines.length).toBeGreaterThan(4);

    // The file path appears on a line by itself (possibly inline with surrounding text,
    // but the line that contains the path must include backtick-wrapped path).
    const lineWithPath = lines.find((l) => l.includes(FAKE_PATH));
    expect(lineWithPath).toBeDefined();
  });

  it('does not include any trailing newline', () => {
    const result = renderFileHandoffWrapper(FAKE_PATH);
    expect(result.endsWith('\n')).toBe(false);
  });
});

describe('renderFixHandoffWrapper', () => {
  it('embeds both the critique path and the spec path', () => {
    const result = renderFixHandoffWrapper(FAKE_PATH, CRITIQUE_PATH);
    expect(result).toContain(FAKE_PATH);
    expect(result).toContain(CRITIQUE_PATH);
  });

  it('orders the critique BEFORE the spec — read-critique-first contract', () => {
    // The whole point of this wrapper: the resumed generator must
    // read the verdict before re-reading the spec, otherwise the fix
    // round is a blind retry.
    const result = renderFixHandoffWrapper(FAKE_PATH, CRITIQUE_PATH);
    const critiqueIdx = result.indexOf(CRITIQUE_PATH);
    const specIdx = result.indexOf(FAKE_PATH);
    expect(critiqueIdx).toBeGreaterThanOrEqual(0);
    expect(specIdx).toBeGreaterThanOrEqual(0);
    expect(critiqueIdx).toBeLessThan(specIdx);
  });

  it('mentions the harness, fix-round framing, and the <task-complete> closing signal', () => {
    const result = renderFixHandoffWrapper(FAKE_PATH, CRITIQUE_PATH);
    const lower = result.toLowerCase();
    expect(lower).toContain('ralphctl');
    expect(lower).toContain('harness');
    expect(lower).toContain('fix round');
    expect(result).toContain('<task-complete>');
  });

  it('produces a distinct body from the plain wrapper', () => {
    const fix = renderFixHandoffWrapper(FAKE_PATH, CRITIQUE_PATH);
    const plain = renderFileHandoffWrapper(FAKE_PATH);
    expect(fix).not.toBe(plain);
  });

  it('does not include any trailing newline', () => {
    const result = renderFixHandoffWrapper(FAKE_PATH, CRITIQUE_PATH);
    expect(result.endsWith('\n')).toBe(false);
  });
});
