import { describe, expect, it } from 'vitest';
import { formatBytes } from '@src/application/ui/shared/format-bytes.ts';

describe('formatBytes', () => {
  it('renders sub-KiB values in bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
  });

  it('rolls over to KiB / MiB / GiB with one decimal', () => {
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MiB');
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GiB');
  });

  it('clamps negative and non-finite input to 0 B', () => {
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B');
  });
});
