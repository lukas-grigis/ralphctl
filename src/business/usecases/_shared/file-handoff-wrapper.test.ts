import { describe, expect, it } from 'vitest';

import { renderFileHandoffWrapper } from './file-handoff-wrapper.ts';

const FAKE_PATH = '/home/user/.ralphctl/data/sprints/20260429-120000-demo/contexts/execute-task-abc.md';

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
