/**
 * Keyboard-ownership fences (source greps). Three rules keep "one owner per keystroke" true:
 *
 *   - views declare keys through `useViewKeys`, never a bare `useViewHints` (a second, hand-synced
 *     source for the footer is how hints and handlers drifted);
 *   - the help overlay mounts once, in the App Layout — never inside a view;
 *   - no view branches on `helpOpen` (the active view stays mounted under the overlay).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const TUI = 'src/application/ui/tui';

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
  });

const offenders = (files: readonly string[], pattern: RegExp): string[] =>
  files.filter((f) => pattern.test(readFileSync(f, 'utf8')));

describe('keyboard ownership — source fences', () => {
  it('no file under views/ calls useViewHints(', () => {
    expect(offenders(walk(join(TUI, 'views')), /\buseViewHints\(/)).toEqual([]);
  });

  it('<HelpOverlay is mounted only by App.tsx', () => {
    const mounts = offenders(walk(TUI), /<HelpOverlay\b/).filter((f) => !f.endsWith('components/help-overlay.tsx'));
    expect(mounts).toEqual([join(TUI, 'App.tsx')]);
  });

  it('no view branches on `helpOpen ?`', () => {
    expect(offenders(walk(join(TUI, 'views')), /helpOpen\s*\?/)).toEqual([]);
  });

  it('the global handler no longer owns `y` (copy is Execute-local)', () => {
    const src = readFileSync(join(TUI, 'runtime/use-global-keys.ts'), 'utf8');
    expect(src).not.toMatch(/input\s*!==?\s*'y'|handleYankCopy/);
  });
});
