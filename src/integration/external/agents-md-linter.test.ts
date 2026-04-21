import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectCommandDrift, lintAgentsMd } from './agents-md-linter.ts';

const WELL_SHAPED_BODY = [
  '# Project',
  '',
  'A short intro with simple words.',
  '',
  '## Project Overview',
  '',
  'What this repo is.',
  '',
  '## Build & Run',
  '',
  'Run the build script.',
  '',
  '## Testing',
  '',
  'Run the test script.',
  '',
  '## Architecture',
  '',
  'Top-level layers.',
  '',
  '## Implementation Style',
  '',
  'Conventions.',
  '',
  '## Security & Safety',
  '',
  'Auth rules.',
  '',
  '## Performance Constraints',
  '',
  'LOW-CONFIDENCE: no budgets.',
].join('\n');

describe('lintAgentsMd', () => {
  it('passes a short well-shaped document', () => {
    const result = lintAgentsMd(WELL_SHAPED_BODY);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('flags each missing required H2 section by name', () => {
    // Build a document with every required section except the one under test.
    const present = [
      '## Project Overview',
      '## Build & Run',
      '## Testing',
      '## Architecture',
      '## Implementation Style',
      '## Security & Safety',
      '## Performance Constraints',
    ];
    for (const missing of present) {
      const sections = present.filter((s) => s !== missing);
      const body = `# T\n\nintro.\n\n${sections.map((s) => `${s}\n\nbody.`).join('\n\n')}`;
      const result = lintAgentsMd(body);
      const label = missing.replace(/^##\s+/, '');
      const violation = result.violations.find((v) => v.rule === 'required-section' && v.message.includes(label));
      expect(violation, `expected violation for missing ${missing}`).toBeDefined();
    }
  });

  it('matches required sections case-insensitively', () => {
    const body = WELL_SHAPED_BODY.replace('## Testing', '## testing').replace(
      '## Security & Safety',
      '## SECURITY & SAFETY'
    );
    const result = lintAgentsMd(body);
    expect(result.violations.filter((v) => v.rule === 'required-section')).toEqual([]);
  });

  it('flags multiple H1 headings', () => {
    const content = '# One\n\nbody.\n\n# Two\n\nbody.';
    const result = lintAgentsMd(content);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.rule === 'single-h1')).toBe(true);
  });

  it('flags missing H1', () => {
    const content = '## Only H2\n\nbody.';
    const result = lintAgentsMd(content);
    expect(result.violations.some((v) => v.rule === 'single-h1')).toBe(true);
  });

  it('flags more than 7 H2 sections', () => {
    const sections = Array.from({ length: 9 }, (_, i) => `## S${String(i)}\n\nbody.`).join('\n\n');
    const content = `# T\n\nintro.\n\n${sections}`;
    const result = lintAgentsMd(content);
    expect(result.violations.some((v) => v.rule === 'max-h2')).toBe(true);
  });

  it('flags H4 and deeper headings', () => {
    const content = '# T\n\nbody.\n\n## A\n\nbody.\n\n#### Too deep\n\nbody.';
    const result = lintAgentsMd(content);
    expect(result.violations.some((v) => v.rule === 'no-h4-plus')).toBe(true);
  });

  it('ignores headings inside fenced code blocks', () => {
    const content = '# T\n\nbody.\n\n```\n#### inside code\n```\n';
    const result = lintAgentsMd(content);
    expect(result.violations.some((v) => v.rule === 'no-h4-plus')).toBe(false);
  });

  it('flags overly long documents', () => {
    const content = `# T\n\n${'line\n'.repeat(310)}`;
    const result = lintAgentsMd(content);
    expect(result.violations.some((v) => v.rule === 'max-lines')).toBe(true);
  });
});

describe('detectCommandDrift', () => {
  it('warns when project context file references a missing npm script', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onboard-lint-'));
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
      const warnings = detectCommandDrift('Run `pnpm lint` before committing.', dir);
      expect(warnings.some((w) => w.includes('lint'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('silent when referenced scripts exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onboard-lint-'));
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .' } }));
      const warnings = detectCommandDrift('Run `pnpm lint` before committing.', dir);
      expect(warnings).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no-op when package.json is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onboard-lint-'));
    try {
      expect(detectCommandDrift('pnpm test', dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
