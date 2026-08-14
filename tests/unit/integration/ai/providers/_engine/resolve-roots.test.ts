import { describe, expect, it } from 'vitest';
import { absolutePath } from '@tests/fixtures/domain.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import { READ_ONLY } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import { appendRoot, resolveWritableRoots } from '@src/integration/ai/providers/_engine/resolve-roots.ts';

// Every headless adapter turns this list into its CLI's mount flags (`--add-dir`, or OpenCode's
// blanket `--auto`), so a change here silently widens or narrows what four adapters can write to.
// It shipped untested; these cases pin the rules the adapters and their doc comments rely on.

const CWD = absolutePath('/tmp/resolve-roots-cwd');
const OUTPUT_DIR = absolutePath('/tmp/resolve-roots-out');
const SIBLING = absolutePath('/tmp/resolve-roots-sibling');

const session = (overrides: Partial<AiSession> = {}): AiSession => ({
  prompt: 'body',
  cwd: CWD,
  model: 'any-model',
  permissions: READ_ONLY,
  signalsFile: absolutePath('/tmp/resolve-roots-out/signals.json'),
  ...overrides,
});

const asStrings = (roots: readonly AbsolutePath[]): readonly string[] => roots.map((r) => String(r));

describe('resolveWritableRoots', () => {
  it('returns nothing when the session declares no roots and no output dir', () => {
    // cwd is implicitly mounted by every adapter, so it is deliberately NOT in the list — an
    // adapter that mounted it again would emit a redundant flag pair on every spawn.
    expect(resolveWritableRoots(session())).toEqual([]);
  });

  it('adds outputDir so the audit-[09] signals.json can land outside cwd', () => {
    expect(asStrings(resolveWritableRoots(session({ outputDir: OUTPUT_DIR })))).toEqual([String(OUTPUT_DIR)]);
  });

  it('omits outputDir when it is cwd — already mounted, nothing to add', () => {
    expect(resolveWritableRoots(session({ outputDir: CWD }))).toEqual([]);
  });

  it('does not duplicate an outputDir the caller already declared', () => {
    const roots = resolveWritableRoots(session({ additionalRoots: [SIBLING, OUTPUT_DIR], outputDir: OUTPUT_DIR }));
    expect(asStrings(roots)).toEqual([String(SIBLING), String(OUTPUT_DIR)]);
  });

  it('preserves declared order and appends outputDir last', () => {
    const roots = resolveWritableRoots(session({ additionalRoots: [SIBLING, CWD], outputDir: OUTPUT_DIR }));
    // cwd declared explicitly is kept — `resolveWritableRoots` only suppresses cwd for the
    // candidate it appends, not for what the caller asked for.
    expect(asStrings(roots)).toEqual([String(SIBLING), String(CWD), String(OUTPUT_DIR)]);
  });

  it('de-duplicates by exact string — a trailing-slash spelling is a different root', () => {
    // Pinning current behaviour, not endorsing it: the adapters pass these straight to their CLI,
    // which normalises them itself, so folding them here would be extra machinery with no observed
    // failure behind it. If a duplicate-mount bug ever surfaces, this is the test to change.
    const withSlash = absolutePath('/tmp/resolve-roots-out/');
    const roots = resolveWritableRoots(session({ additionalRoots: [withSlash], outputDir: OUTPUT_DIR }));
    expect(asStrings(roots)).toEqual([String(withSlash), String(OUTPUT_DIR)]);
  });
});

describe('appendRoot', () => {
  it('is the identity when there is no candidate', () => {
    const roots = [SIBLING];
    expect(appendRoot(roots, undefined, String(CWD))).toBe(roots);
  });

  it('drops a candidate equal to cwd', () => {
    expect(appendRoot([SIBLING], CWD, String(CWD))).toEqual([SIBLING]);
  });

  it('drops a candidate already in the list', () => {
    expect(appendRoot([SIBLING], SIBLING, String(CWD))).toEqual([SIBLING]);
  });

  it('appends a genuinely new candidate without mutating the input', () => {
    const roots = [SIBLING];
    expect(asStrings(appendRoot(roots, OUTPUT_DIR, String(CWD)))).toEqual([String(SIBLING), String(OUTPUT_DIR)]);
    expect(roots).toEqual([SIBLING]);
  });
});
