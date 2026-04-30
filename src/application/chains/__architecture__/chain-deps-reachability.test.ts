/**
 * Architectural fence — `ChainSharedDeps` field reachability.
 *
 * Every field declared on `ChainSharedDeps` (the narrow Pick<SharedDeps, …>
 * surface that chain factories accept) must be consumed by at least one
 * chain or chain-leaf file. A dead field is misleading: it implies a chain
 * uses something it doesn't, and the next contributor wires it through
 * cargo-cult instead of intent.
 *
 * Add a field here without consuming it → this test fails. Either delete
 * the field, consume it, or document the slack inline (and update this
 * allow-list).
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CHAINS_ROOT = new URL('..', import.meta.url).pathname;
const DEPS_FILE = join(CHAINS_ROOT, 'chain-deps.ts');

function readDepsFields(): string[] {
  const src = readFileSync(DEPS_FILE, 'utf8');
  const interfaceMatch = /export\s+interface\s+ChainSharedDeps\s*\{([\s\S]*?)\n\}/.exec(src);
  if (!interfaceMatch) throw new Error('Could not locate `ChainSharedDeps` interface in chain-deps.ts');
  const body = interfaceMatch[1] ?? '';
  const fields: string[] = [];
  for (const line of body.split('\n')) {
    const fieldMatch = /^\s*readonly\s+(\w+)\s*:/.exec(line);
    if (fieldMatch?.[1]) fields.push(fieldMatch[1]);
  }
  return fields;
}

function* walkChainSources(): Generator<string> {
  for (const entry of readdirSync(CHAINS_ROOT)) {
    const full = join(CHAINS_ROOT, entry);
    if (entry.startsWith('.') || entry === '__architecture__' || entry === 'chain-deps.ts') continue;
    const stat = statSync(full);
    if (!stat.isDirectory()) continue;
    for (const file of readdirSync(full)) {
      if ((file.endsWith('.ts') || file.endsWith('.tsx')) && !file.endsWith('.test.ts')) {
        yield join(full, file);
      }
    }
  }
}

describe('ChainSharedDeps field reachability', () => {
  const fields = readDepsFields();
  const allChainSrc = [...walkChainSources()].map((path) => readFileSync(path, 'utf8')).join('\n');

  it('parses at least 8 fields off the ChainSharedDeps interface', () => {
    // Sanity: today's interface has ~10 fields. If this drops sharply the
    // parser is broken, not the interface.
    expect(fields.length).toBeGreaterThanOrEqual(8);
  });

  it.each(fields)('field `%s` is consumed by at least one chain file', (field) => {
    // Look for `deps.<field>` or `<field}` (destructured) usage. Both shapes
    // are legitimate — chains either thread `deps` straight through or
    // destructure inside a leaf factory.
    const direct = new RegExp(`\\bdeps\\.${field}\\b`);
    const destructured = new RegExp(`\\{[^}]*\\b${field}\\b[^}]*\\}\\s*=\\s*deps`);
    expect(
      direct.test(allChainSrc) || destructured.test(allChainSrc),
      `\`${field}\` is declared on ChainSharedDeps but no chain file consumes it. Either delete the field or use it.`
    ).toBe(true);
  });
});
