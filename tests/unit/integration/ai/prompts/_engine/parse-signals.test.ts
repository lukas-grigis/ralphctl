import { describe, expect, it } from 'vitest';
import { isoTimestamp } from '@tests/fixtures/domain.ts';
import { parseHarnessSignals } from '@src/integration/ai/signals/_engine/parse-signals.ts';

const NOW = isoTimestamp('2026-05-09T10:00:00.000Z');

describe('parseHarnessSignals', () => {
  it('returns no signals on empty input', () => {
    expect(parseHarnessSignals('', NOW)).toEqual([]);
  });

  it('returns no signals on signal-free text', () => {
    expect(parseHarnessSignals('Just a regular markdown body.\n\nNothing tagged.', NOW)).toEqual([]);
  });

  it('parses <task-complete> as a self-closing signal', () => {
    expect(parseHarnessSignals('Done. <task-complete>', NOW)).toEqual([{ type: 'task-complete', timestamp: NOW }]);
  });

  it('accepts <task-complete/> and <task-complete></task-complete> variants', () => {
    expect(parseHarnessSignals('<task-complete/>', NOW)).toHaveLength(1);
    expect(parseHarnessSignals('<task-complete></task-complete>', NOW)).toHaveLength(1);
  });

  it('parses <task-verified> with trimmed body', () => {
    const text = `before
<task-verified>
$ pnpm test
PASS
</task-verified>
after`;
    const signals = parseHarnessSignals(text, NOW);
    expect(signals).toEqual([{ type: 'task-verified', output: '$ pnpm test\nPASS', timestamp: NOW }]);
  });

  it('parses <task-blocked> with reason', () => {
    expect(parseHarnessSignals('<task-blocked>missing dep X</task-blocked>', NOW)).toEqual([
      { type: 'task-blocked', reason: 'missing dep X', timestamp: NOW },
    ]);
  });

  it('parses <note> and <progress>', () => {
    const signals = parseHarnessSignals('<progress>step 2/4</progress> <note>cache layout matters</note>', NOW);
    expect(signals).toEqual([
      { type: 'progress', summary: 'step 2/4', timestamp: NOW },
      { type: 'note', text: 'cache layout matters', timestamp: NOW },
    ]);
  });

  it('parses <evaluation-passed> as the verdict signal', () => {
    expect(parseHarnessSignals('All dimensions met. <evaluation-passed>', NOW)).toEqual([
      { type: 'evaluation', status: 'passed', dimensions: [], timestamp: NOW },
    ]);
  });

  it('parses <evaluation-failed> with critique body', () => {
    const text = '<evaluation-failed>Missing edge case for empty input</evaluation-failed>';
    expect(parseHarnessSignals(text, NOW)).toEqual([
      {
        type: 'evaluation',
        status: 'failed',
        dimensions: [],
        critique: 'Missing edge case for empty input',
        timestamp: NOW,
      },
    ]);
  });

  it('preserves document order across mixed signals', () => {
    const text = `Working...
<progress>halfway</progress>
<task-verified>$ pnpm test
ok</task-verified>
<task-complete>`;
    const types = parseHarnessSignals(text, NOW).map((s) => s.type);
    expect(types).toEqual(['progress', 'task-verified', 'task-complete']);
  });

  it('does not double-count tags nested inside a pair body', () => {
    // A literal <task-complete> appearing inside the verified output must NOT be parsed as a
    // separate task-complete signal — the verified block is consumed first.
    const text = `<task-verified>
$ echo "<task-complete>"
<task-complete>
</task-verified>
<task-complete>`;
    const signals = parseHarnessSignals(text, NOW);
    expect(signals.map((s) => s.type)).toEqual(['task-verified', 'task-complete']);
    expect((signals[0] as { output: string }).output).toContain('<task-complete>');
  });

  it('handles multiple instances of the same tag', () => {
    const text = '<note>one</note> <note>two</note> <note>three</note>';
    const signals = parseHarnessSignals(text, NOW);
    expect(signals).toHaveLength(3);
    expect(signals.map((s) => (s as { text: string }).text)).toEqual(['one', 'two', 'three']);
  });

  it('is safe to call concurrently — no shared regex state', async () => {
    const a = parseHarnessSignals('<note>a</note>', NOW);
    const b = parseHarnessSignals('<note>b</note>', NOW);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });
});
