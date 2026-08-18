/**
 * `isArgvOverflow` decides whether a spawn failure gets blamed on the command-line size. Getting
 * it wrong is expensive in one direction: a false positive turns a retryable, actionable failure
 * (CLI missing from PATH) into a non-retryable "argv overflow" that stops the attempt ladder and
 * sends the operator after the wrong problem.
 *
 * The split under test: the ENAMETOOLONG / E2BIG errnos are trusted everywhere; the size-only
 * heuristic is win32-only, because that is the only platform whose ceiling is 32,767 bytes.
 */
import { describe, expect, it } from 'vitest';
import { argvByteLength, errnoOf, isArgvOverflow } from '@src/integration/ai/providers/_engine/argv-budget.ts';

const WINDOWS_CEILING = 32_767;

describe('isArgvOverflow', () => {
  it.each<NodeJS.Platform>(['win32', 'darwin', 'linux'])('trusts the overflow errnos on %s', (platform) => {
    expect(isArgvOverflow('ENAMETOOLONG', 0, platform)).toBe(true);
    expect(isArgvOverflow('E2BIG', 0, platform)).toBe(true);
  });

  it('applies the size-only heuristic on win32, where the errno is unreliable', () => {
    expect(isArgvOverflow('UNKNOWN', WINDOWS_CEILING, 'win32')).toBe(true);
    expect(isArgvOverflow(undefined, 40_000, 'win32')).toBe(true);
  });

  it.each<NodeJS.Platform>(['darwin', 'linux'])(
    'does NOT apply the size-only heuristic on %s (ARG_MAX is ~1 MiB there)',
    (platform) => {
      expect(isArgvOverflow('ENOENT', 40_000, platform)).toBe(false);
      expect(isArgvOverflow('EACCES', 200_000, platform)).toBe(false);
      expect(isArgvOverflow('UNKNOWN', WINDOWS_CEILING, platform)).toBe(false);
    }
  );

  it('leaves a below-ceiling failure alone on every platform', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(isArgvOverflow('ENOENT', WINDOWS_CEILING - 1, platform)).toBe(false);
    }
  });
});

describe('argvByteLength / errnoOf', () => {
  it('counts the command, every argument, and one separator each', () => {
    // 'cli' (3) + '-a' (2 + 1) + 'bb' (2 + 1) = 9
    expect(argvByteLength('cli', ['-a', 'bb'])).toBe(9);
  });

  it('measures bytes, not characters, so multi-byte prompts are not undercounted', () => {
    expect(argvByteLength('cli', ['—'])).toBe(3 + 3 + 1);
  });

  it('prefers the errno code and falls back to the error name', () => {
    expect(errnoOf(Object.assign(new Error('boom'), { code: 'E2BIG' }))).toBe('E2BIG');
    expect(errnoOf(new Error('boom'))).toBe('Error');
    expect(errnoOf('not an error')).toBeUndefined();
  });
});
