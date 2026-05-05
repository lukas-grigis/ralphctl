import { describe, expect, it } from 'vitest';

import { renderFileHandoffWrapper, renderFixHandoffWrapper } from './file-handoff-wrapper.ts';

const FAKE_PATH = '/home/user/.ralphctl/data/sprints/20260429-120000-demo/contexts/execute-task-abc.md';
const CRITIQUE_BODY = [
  '# Evaluation — failed',
  '',
  '## Dimensions',
  '- **correctness** (score 2/5): FAIL — null-input branch returns undefined.',
  '- **completeness** (score 4/5): PASS — covers the happy path.',
  '',
  '## Notes',
  'Fix the null-input handling and add a regression test.',
].join('\n');

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
  it('inlines the critique body verbatim and embeds the spec path', () => {
    const result = renderFixHandoffWrapper(FAKE_PATH, CRITIQUE_BODY);
    expect(result).toContain(CRITIQUE_BODY);
    expect(result).toContain(FAKE_PATH);
  });

  it('wraps the critique in <evaluator-critique> tags so the AI can locate it unambiguously', () => {
    const result = renderFixHandoffWrapper(FAKE_PATH, CRITIQUE_BODY);
    expect(result).toContain('<evaluator-critique>');
    expect(result).toContain('</evaluator-critique>');
    const openIdx = result.indexOf('<evaluator-critique>');
    const bodyIdx = result.indexOf(CRITIQUE_BODY);
    const closeIdx = result.indexOf('</evaluator-critique>');
    expect(openIdx).toBeLessThan(bodyIdx);
    expect(bodyIdx).toBeLessThan(closeIdx);
  });

  it('orders the critique BEFORE the spec — read-critique-first contract', () => {
    // The whole point of this wrapper: the resumed generator must
    // read the verdict before re-reading the spec, otherwise the fix
    // round is a blind retry.
    const result = renderFixHandoffWrapper(FAKE_PATH, CRITIQUE_BODY);
    const critiqueIdx = result.indexOf(CRITIQUE_BODY);
    const specIdx = result.indexOf(FAKE_PATH);
    expect(critiqueIdx).toBeGreaterThanOrEqual(0);
    expect(specIdx).toBeGreaterThanOrEqual(0);
    expect(critiqueIdx).toBeLessThan(specIdx);
  });

  it('mentions the harness, fix-round framing, and the <task-complete> closing signal', () => {
    const result = renderFixHandoffWrapper(FAKE_PATH, CRITIQUE_BODY);
    const lower = result.toLowerCase();
    expect(lower).toContain('ralphctl');
    expect(lower).toContain('harness');
    expect(lower).toContain('fix round');
    expect(result).toContain('<task-complete>');
  });

  it('produces a distinct body from the plain wrapper', () => {
    const fix = renderFixHandoffWrapper(FAKE_PATH, CRITIQUE_BODY);
    const plain = renderFileHandoffWrapper(FAKE_PATH);
    expect(fix).not.toBe(plain);
  });

  it('does not include any trailing newline', () => {
    const result = renderFixHandoffWrapper(FAKE_PATH, CRITIQUE_BODY);
    expect(result.endsWith('\n')).toBe(false);
  });

  it('escapes embedded </evaluator-critique> tags in the critique body so the wrapper boundary stays unambiguous', () => {
    // The evaluator AI could quote the tag (it's named in dimensions.md)
    // and a literal closing tag inside the body would close the wrapper
    // early. Replace it with a backslash-escaped form that the resumed
    // generator can still read but doesn't terminate the wrapper.
    const adversarial = [
      'A naive evaluator might emit </evaluator-critique> mid-body.',
      'Even </evaluator-critique> appearing at column 0 must not close the wrapper early.',
    ].join('\n');
    const result = renderFixHandoffWrapper(FAKE_PATH, adversarial);
    // The body's closing tags are escaped — exactly one un-escaped
    // `</evaluator-critique>` remains: the wrapper's own closing tag.
    const unescapedCloses = result.split('</evaluator-critique>').length - 1;
    expect(unescapedCloses).toBe(1);
    // The escaped form appears in the body so the generator still
    // sees the literal mention.
    expect(result).toContain('<\\/evaluator-critique>');
    // The escaped-form count matches the number of adversarial close
    // tags we injected (two).
    const escapedCloses = result.split('<\\/evaluator-critique>').length - 1;
    expect(escapedCloses).toBe(2);
  });
});
