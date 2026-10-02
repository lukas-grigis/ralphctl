import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';
import { askLine, isYes } from '@src/application/ui/cli/confirm-destructive.ts';

const makeInterface = (): { readonly rl: ReturnType<typeof createInterface>; readonly input: PassThrough } => {
  const input = new PassThrough();
  return { rl: createInterface({ input, output: new PassThrough() }), input };
};

describe('askLine', () => {
  it('resolves undefined when the interface closes mid-question (Ctrl-C / Ctrl-D)', async () => {
    const { rl } = makeInterface();
    const pending = askLine(rl, 'q? ');
    rl.close();
    await expect(pending).resolves.toBeUndefined();
  });

  it('resolves the typed answer', async () => {
    const { rl, input } = makeInterface();
    const pending = askLine(rl, 'q? ');
    input.write('y\n');
    await expect(pending).resolves.toBe('y');
    rl.close();
  });
});

describe('isYes', () => {
  it('accepts y / yes case-insensitively and rejects anything else', () => {
    expect(isYes('YES')).toBe(true);
    expect(isYes('y')).toBe(true);
    expect(isYes('n')).toBe(false);
    expect(isYes('')).toBe(false);
  });
});
