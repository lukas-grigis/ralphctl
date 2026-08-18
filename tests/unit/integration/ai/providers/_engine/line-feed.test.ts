/**
 * The shared NDJSON line splitter splits on `\n` only. On a CRLF stream (Windows-hosted CLI, or a
 * PTY that translates `\n` → `\r\n`) that leaves a trailing `\r` on every line — one stray byte
 * that used to defeat the downstream JSON guards and silently drop session-id / body / usage.
 * These tests pin the normalisation at the split site, for both `feed` and `flush`.
 */

import { describe, expect, it } from 'vitest';
import { createCappedLineFeed } from '@src/integration/ai/providers/_engine/line-feed.ts';

/** Identity emitter — surfaces exactly what the splitter handed to the parser-specific callback. */
const collect = (chunks: readonly string[], { withFlush = true } = {}): readonly string[] => {
  const lines: string[] = [];
  const feeder = createCappedLineFeed<string>('test-stream', (raw, onLine) => {
    onLine(raw);
  });
  for (const c of chunks) feeder.feed(c, (l) => lines.push(l));
  if (withFlush) feeder.flush((l) => lines.push(l));
  return lines;
};

describe('createCappedLineFeed', () => {
  it('splits LF-terminated lines without the terminator', () => {
    expect(collect(['a\nb\n'])).toEqual(['a', 'b']);
  });

  it('strips the CR of a CRLF line ending', () => {
    expect(collect(['{"type":"system"}\r\n'])).toEqual(['{"type":"system"}']);
  });

  it('strips the CR on every line of a multi-line CRLF chunk', () => {
    expect(collect(['one\r\ntwo\r\nthree\r\n'])).toEqual(['one', 'two', 'three']);
  });

  it('strips a trailing CR from the flushed partial line (stream ended without a newline)', () => {
    expect(collect(['tail\r'])).toEqual(['tail']);
  });

  it('keeps interior CRs — only the line ending is normalised', () => {
    expect(collect(['a\rb\r\n'])).toEqual(['a\rb']);
  });

  it('normalises a CRLF split across chunk boundaries', () => {
    // The `\r` lands at the end of one chunk, the `\n` at the start of the next.
    expect(collect(['first\r', '\nsecond\r\n'])).toEqual(['first', 'second']);
  });

  it('emits a blank line for a bare CRLF (emitters skip empties themselves)', () => {
    expect(collect(['\r\n'], { withFlush: false })).toEqual(['']);
  });

  it('holds an unterminated line until its newline arrives', () => {
    expect(collect(['par', 'tial\r\n'], { withFlush: false })).toEqual(['partial']);
  });
});
