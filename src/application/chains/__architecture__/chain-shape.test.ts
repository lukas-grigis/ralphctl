/**
 * Architectural fence — chain-factory shape.
 *
 * Locks in the convention every workflow chain must follow so future
 * additions stay coherent with existing factories (refine, plan, ideate,
 * execute, evaluate, feedback, onboard, create-pr).
 *
 * Failures here mean the chain layer is drifting. Either fix the new file
 * to match the convention, or — if the convention itself is wrong — update
 * this test deliberately and document the new shape in
 * `.claude/docs/ARCHITECTURE.md`.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CHAINS_ROOT = new URL('..', import.meta.url).pathname;

function listChainFiles(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(CHAINS_ROOT)) {
    const full = join(CHAINS_ROOT, entry);
    // Skip the `__architecture__` test folder itself, the `leaves/` shared
    // helpers, and any non-directory entries (chain-deps.ts lives at root).
    if (entry === '__architecture__' || entry === 'leaves' || entry.startsWith('.')) continue;
    if (!statSync(full).isDirectory()) continue;
    for (const file of readdirSync(full)) {
      if (file.endsWith('-flow.ts') && !file.endsWith('.test.ts')) {
        out.push(join(full, file));
      }
    }
  }
  return out;
}

describe('chain factory shape', () => {
  const files = listChainFiles();

  it('discovers at least the seven canonical chain factories', () => {
    const names = files.map((f) => f.split('/').slice(-2).join('/'));
    expect(names).toStrictEqual(
      expect.arrayContaining([
        'refine/refine-flow.ts',
        'plan/plan-flow.ts',
        'ideate/ideate-flow.ts',
        'evaluate/evaluate-flow.ts',
        'feedback/feedback-flow.ts',
        'onboard/onboard-flow.ts',
        'create-pr/create-pr-flow.ts',
      ])
    );
  });

  it.each(files)('%s exports a function whose name ends with `Flow`', (file) => {
    const src = readFileSync(file, 'utf8');
    // Match `export function createXxxFlow(...)` or `export const createXxxFlow = ...`
    expect(src).toMatch(/export\s+(?:function|const)\s+\w+Flow\b/);
  });

  it.each(files)('%s does not import from the workflow-use-case orchestration directories directly', (file) => {
    const src = readFileSync(file, 'utf8');
    // Workflow chains may use the *use case classes* (that's their job) but
    // should not reach across into sibling chain folders. This guards against
    // accidental coupling between flows.
    const sibling = file.split('/').slice(-2)[0] ?? '';
    const others = ['refine', 'plan', 'ideate', 'evaluate', 'feedback', 'onboard', 'create-pr', 'execute'].filter(
      (n) => n !== sibling
    );
    for (const other of others) {
      expect(src, `chain ${sibling} should not import from ${other}`).not.toMatch(
        new RegExp(`from\\s+['"]\\.\\./${other}/`)
      );
    }
  });
});
