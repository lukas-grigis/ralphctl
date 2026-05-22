import { describe, expect, it } from 'vitest';
import {
  createCopilotStreamParser,
  type CopilotStreamLine,
} from '@src/integration/ai/providers/copilot/parse-stream.ts';

/**
 * Pins the body-accumulation contract used inside `copilot/headless.ts#spawnAttempt`:
 * append each entry to an array, then `.join('\n')` once at the end. Byte-identical to the
 * prior per-line `body = ${body}\n${raw}` form, but O(N) — the drift guard against
 * reintroducing the quadratic concatenation.
 *
 * The production buffer now splits assistant-body events from forensic events (prompt-echo
 * leak fix), but the join-equivalence claim is the same on either view: a single `.join('\n')`
 * at the consumer. This helper mirrors the join over the forensic (non-JSON) projection,
 * which still feeds body.txt.
 */
const accumulateBody = (chunks: readonly string[]): string => {
  const parser = createCopilotStreamParser();
  const forensicLines: string[] = [];
  const onLine = (line: CopilotStreamLine): void => {
    if (line.json !== undefined) return;
    forensicLines.push(line.raw);
  };
  for (const chunk of chunks) parser.feed(chunk, onLine);
  parser.flush(onLine);
  return forensicLines.join('\n');
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
