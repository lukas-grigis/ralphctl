import { promises as fs } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluatorOutputContract } from '@src/application/flows/implement/leaves/evaluator.contract.ts';

/**
 * Fence on the vendor-neutral prompt state: no vendor tool names, no reasoning-extraction fields,
 * no thinking-control prose, and a critique example shape that matches the verdict rules.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', '..', '..', '..', 'src', 'integration', 'ai');
const PROMPTS_DIR = join(SRC, 'prompts');
const SKILLS_DIR = join(SRC, 'skills', 'bundled');
const SIGNALS_DIR = join(SRC, 'contract', '_engine', 'signals');

const walk = async (dir: string, keep: (name: string) => boolean): Promise<string[]> => {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, keep)));
    else if (keep(entry.name)) out.push(full);
  }
  return out;
};

const loadAll = async (dir: string, keep: (name: string) => boolean): Promise<Array<[string, string]>> => {
  const files = (await walk(dir, keep)).sort();
  return Promise.all(
    files.map(async (f): Promise<[string, string]> => [relative(SRC, f), await fs.readFile(f, 'utf8')])
  );
};

/** The three conventions-* partials name vendor files by design; only vendor file names are exempt. */
const isConventions = (rel: string): boolean => basename(rel).startsWith('conventions-');

const VENDOR_TOOLS = /\b(apply_patch|multi_tool_use|TodoWrite|AskUserQuestion|update_plan|WebFetch)\b/u;
const TOOL_PHRASE = /\bthe (Bash|Edit|Write|Read|Task) tool\b|`(Bash|Edit|Write|Read|Task)`/u;
const REASONING_KEY = /["'](reasoning|thinking|scratchpad|trace|thoughts)["']\s*:/u;
const REASONING_TAG = /<\/?(thinking|scratchpad)>/u;
const THINKING_PROSE = /step by step|think (carefully|hard|deeply)|show your (work|reasoning)/iu;
const FALSE_CLAIM = /harness automatically appends/iu;

const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  ['vendor tool identifier', VENDOR_TOOLS],
  ['vendor tool phrase', TOOL_PHRASE],
  ['reasoning field', REASONING_KEY],
  ['reasoning tag', REASONING_TAG],
  ['thinking-control prose', THINKING_PROSE],
  ['false harness claim', FALSE_CLAIM],
];

const violations = (files: ReadonlyArray<[string, string]>): string[] => {
  const found: string[] = [];
  for (const [rel, body] of files) {
    for (const [label, re] of FORBIDDEN) {
      if (isConventions(rel) && label.startsWith('vendor tool')) continue;
      const m = re.exec(body);
      if (m) found.push(`${rel}: ${label} "${m[0]}"`);
    }
  }
  return found;
};

describe('prompt hygiene', () => {
  it('scans a non-trivial file set', async () => {
    const prompts = await loadAll(PROMPTS_DIR, (n) => n.endsWith('.md'));
    const skills = await loadAll(SKILLS_DIR, (n) => n === 'SKILL.md');
    expect(prompts.length).toBeGreaterThan(20);
    expect(skills.length).toBeGreaterThan(0);
  });

  it('prompt templates and partials carry no forbidden vocabulary', async () => {
    expect(violations(await loadAll(PROMPTS_DIR, (n) => n.endsWith('.md')))).toEqual([]);
  });

  it('bundled skills carry no forbidden vocabulary', async () => {
    expect(violations(await loadAll(SKILLS_DIR, (n) => n === 'SKILL.md'))).toEqual([]);
  });

  it('signal schemas declare no reasoning-style keys', async () => {
    const schemas = await loadAll(SIGNALS_DIR, (n) => n.endsWith('.ts'));
    const keyRe = /^\s*(reasoning|thinking|scratchpad|trace|thoughts)\s*:/mu;
    const found = schemas.filter(([, body]) => keyRe.test(body)).map(([rel]) => rel);
    expect(found).toEqual([]);
  });

  it('the detector flags each injected violation', () => {
    const samples = [
      'use apply_patch here',
      'call the Bash tool',
      'run `Bash`',
      '{ "reasoning": "x" }',
      '<thinking>x</thinking>',
      'think step by step',
      'the harness automatically appends the block',
    ];
    for (const s of samples) expect(violations([['x.md', s]])).not.toEqual([]);
  });

  it('conventions partials are exempt from vendor names only', () => {
    expect(violations([['prompts/_partials/conventions-agents-md.md', 'the Bash tool']])).toEqual([]);
    expect(violations([['prompts/_partials/conventions-agents-md.md', '"thinking": 1']])).not.toEqual([]);
  });
});

describe('critique example format', () => {
  const CRITIQUE_LINE = /^- \[([^\]]+)\]/u;
  // The pointer must name a file (`path.ext` or `path.ext:line`), not just say "look at".
  const LOCATION = /\blook at `?[\w-]+(?:[./][\w-]+)*\.[A-Za-z]{1,4}\b(?::\d+)?/u;

  it('the location fence rejects a pointer with no file', () => {
    expect('- [Completeness] nothing changed; look at the declared steps above.').not.toMatch(LOCATION);
    expect('- [Correctness] `foo()` misbehaves; look at `the handler`.').not.toMatch(LOCATION);
    expect('- [Correctness] off by one; look at src/foo.ts:23.').toMatch(LOCATION);
    expect('- [Correctness] env read missing; look at `app/session.py` and its imports.').toMatch(LOCATION);
  });

  it('every critique line in the evaluator contract carries a dimension tag and a location', () => {
    const lines: string[] = [];
    for (const sig of evaluatorOutputContract.exampleSignals) {
      if (sig.type !== 'evaluation' || sig.critique === undefined) continue;
      lines.push(...sig.critique.split('\n').filter((l) => l.startsWith('- [')));
    }
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const tag = CRITIQUE_LINE.exec(line)?.[1] ?? '';
      expect(tag, line).toMatch(/[A-Z][A-Za-z]+/u);
      expect(line.replace(CRITIQUE_LINE, ''), line).toMatch(LOCATION);
    }
  });

  it('every critique line in the evaluate templates carries a dimension tag and a location', async () => {
    const files = [
      ...(await loadAll(join(PROMPTS_DIR, 'evaluate'), (n) => n === 'template.md')),
      ...(await loadAll(join(PROMPTS_DIR, 'evaluate-continuation'), (n) => n === 'template.md')),
    ];
    let seen = 0;
    for (const [rel, body] of files) {
      const rows = body.split('\n');
      rows.forEach((raw, i) => {
        const m = /^\s*(?:"critique":\s*")?(- \[(?:Correctness|Completeness|Safety|Consistency)[^\]]*\].*)$/u.exec(raw);
        if (!m?.[1]) return;
        seen++;
        // Wrapped bullets continue on the following indented lines.
        let entry = m[1];
        for (let j = i + 1; j < rows.length && /^\s+\S/u.test(rows[j] ?? '') && !/^\s*- /u.test(rows[j] ?? ''); j++) {
          entry += ` ${rows[j]?.trim() ?? ''}`;
        }
        expect(entry, `${rel}: ${raw}`).toMatch(LOCATION);
      });
    }
    expect(seen).toBeGreaterThan(0);
  });
});
