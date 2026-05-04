import { describe, expect, it } from 'vitest';

import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { buildAdditionalCwdArgs } from './add-dir-args.ts';

function abs(p: string): AbsolutePath {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

describe('buildAdditionalCwdArgs', () => {
  it('returns [] when the input is undefined', () => {
    expect(buildAdditionalCwdArgs(undefined)).toStrictEqual([]);
  });

  it('returns [] when the input is empty', () => {
    expect(buildAdditionalCwdArgs([])).toStrictEqual([]);
  });

  it('emits one `--add-dir <path>` pair per input path, preserving order', () => {
    const paths = [abs('/repos/a'), abs('/repos/b'), abs('/repos/c')];
    expect(buildAdditionalCwdArgs(paths)).toStrictEqual([
      '--add-dir',
      '/repos/a',
      '--add-dir',
      '/repos/b',
      '--add-dir',
      '/repos/c',
    ]);
  });

  it('renders the absolute path verbatim via String()', () => {
    const paths = [abs('/tmp/demo-repo')];
    const args = buildAdditionalCwdArgs(paths);
    expect(args).toStrictEqual(['--add-dir', '/tmp/demo-repo']);
  });
});
