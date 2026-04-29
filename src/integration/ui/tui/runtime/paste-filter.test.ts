/**
 * Verify the bracketed-paste filter:
 *   - Plain keystroke chunks pass through untouched (no allocation).
 *   - Buffers / strings carrying `\x1b[200~ … \x1b[201~` have the markers
 *     removed but the payload preserved.
 *   - The stream wrapper restores the original `emit` on teardown so
 *     unmounting the TUI leaves stdin in the same state the harness
 *     received it in.
 */

import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { installPasteFilter, stripPasteMarkers } from './paste-filter.ts';

describe('stripPasteMarkers', () => {
  it('returns plain ASCII strings unchanged', () => {
    expect(stripPasteMarkers('hello')).toBe('hello');
  });

  it('returns plain ASCII buffers unchanged', () => {
    const buf = Buffer.from('hello', 'utf8');
    expect(stripPasteMarkers(buf)).toBe(buf);
  });

  it('strips a complete bracketed-paste block', () => {
    const raw = `\x1b[200~line one\nline two\x1b[201~`;
    expect(stripPasteMarkers(raw)).toBe('line one\nline two');
  });

  it('strips an unmatched start marker (graceful when paste is split across reads)', () => {
    const raw = `\x1b[200~partial`;
    expect(stripPasteMarkers(raw)).toBe('partial');
  });

  it('strips an unmatched end marker', () => {
    const raw = `tail\x1b[201~`;
    expect(stripPasteMarkers(raw)).toBe('tail');
  });

  it('handles buffers carrying paste markers', () => {
    const buf = Buffer.from(`\x1b[200~hi\x1b[201~`, 'utf8');
    expect(stripPasteMarkers(buf).toString()).toBe('hi');
  });

  it('does not alter buffers without escape bytes', () => {
    const buf = Buffer.from('plain', 'utf8');
    expect(stripPasteMarkers(buf)).toBe(buf);
  });
});

describe('installPasteFilter', () => {
  it('rewrites data events through stripPasteMarkers and unbinds on teardown', () => {
    const stream = new EventEmitter();
    const received: string[] = [];
    stream.on('data', (chunk: Buffer | string) => {
      received.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });

    // Cast through `unknown` because EventEmitter satisfies the structural
    // shape `installPasteFilter` needs (it only patches `emit`).
    const teardown = installPasteFilter(stream as unknown as NodeJS.ReadStream);
    stream.emit('data', `\x1b[200~pasted\nlines\x1b[201~`);
    stream.emit('data', 'typed');
    teardown();
    stream.emit('data', `\x1b[200~unwrapped\x1b[201~`);

    expect(received).toEqual(['pasted\nlines', 'typed', '\x1b[200~unwrapped\x1b[201~']);
  });

  it('passes non-string non-buffer payloads straight through', () => {
    const stream = new EventEmitter();
    const received: unknown[] = [];
    stream.on('data', (value: unknown) => received.push(value));

    const teardown = installPasteFilter(stream as unknown as NodeJS.ReadStream);
    stream.emit('data', { not: 'a chunk' });
    teardown();

    expect(received).toEqual([{ not: 'a chunk' }]);
  });
});
