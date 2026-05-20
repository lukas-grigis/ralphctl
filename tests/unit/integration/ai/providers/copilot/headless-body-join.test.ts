import { describe, expect, it } from 'vitest';
import {
  createCopilotStreamParser,
  type CopilotStreamLine,
} from '@src/integration/ai/providers/copilot/parse-stream.ts';

/**
 * Pins the body-accumulation contract used inside `copilot/headless.ts#spawnAttempt`:
 * push each plain-text `line.raw` into an array, then `bodyLines.join('\n')` once at the
 * end. Byte-identical to the prior per-line `body = ${body}\n${raw}` form, but O(N).
 *
 * The join lives inline in `spawnAttempt` (not exported), so the test mirrors that pattern
 * locally against the parser. The drift guard against reintroducing the quadratic
 * concatenation is the adjacent comment in `copilot/headless.ts`; this test's job is the
 * byte-equivalence claim — if `.join('\n')` ever stopped producing `'line0\n…\nline999'`,
 * this fails.
 */
const accumulateBody = (chunks: readonly string[]): string => {
  const parser = createCopilotStreamParser();
  const bodyLines: string[] = [];
  const onLine = (line: CopilotStreamLine): void => {
    if (line.json !== undefined) return;
    bodyLines.push(line.raw);
  };
  for (const chunk of chunks) parser.feed(chunk, onLine);
  parser.flush(onLine);
  return bodyLines.join('\n');
};

describe('copilot headless body accumulator', () => {
  it("empty stream → ''", () => {
    expect(accumulateBody([])).toBe('');
  });

  it('single plain-text line → that line, no trailing newline', () => {
    expect(accumulateBody(['only line\n'])).toBe('only line');
  });

  it('two plain-text lines → joined by a single newline, no trailing newline', () => {
    expect(accumulateBody(['first\n', 'second\n'])).toBe('first\nsecond');
  });

  it('1000 plain-text lines → byte-identical to line0\\n…\\nline999', () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line${String(i)}`);
    const expected = lines.join('\n');
    const stream = lines.map((l) => `${l}\n`);
    expect(accumulateBody(stream)).toBe(expected);
  });

  it('json meta lines are skipped; only plain-text lines contribute to body', () => {
    const meta = JSON.stringify({ session_id: 'sess-1' });
    expect(accumulateBody([`${meta}\n`, 'visible\n', `${meta}\n`, 'tail\n'])).toBe('visible\ntail');
  });
});
