import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSkillContract } from '@src/integration/ai/skills/_engine/skill-contract-checker.ts';

const here = dirname(fileURLToPath(import.meta.url));
// tests/integration/ai/skills/bundled → ../../../../../src/integration/ai/skills/bundled
const bundledRoot = join(here, '..', '..', '..', '..', '..', 'src', 'integration', 'ai', 'skills', 'bundled');

const bundledSkillDirs = (): readonly string[] =>
  readdirSync(bundledRoot)
    .map((entry) => join(bundledRoot, entry))
    .filter((path) => statSync(path).isDirectory());

describe('checkSkillContract — bundled posture skills', () => {
  const dirs = bundledSkillDirs();

  it('discovers the bundled skill folders', () => {
    // Guards against a wrong relative path silently yielding zero skills (vacuous pass).
    // There are 8 bundled skills; a regression that drops one (or regresses the dir) must not pass.
    expect(dirs.length).toBeGreaterThanOrEqual(8);
  });

  for (const dir of dirs) {
    const name = dir.split('/').pop() ?? dir;
    it(`bundled skill "${name}" satisfies the harness contract`, () => {
      const content = readFileSync(join(dir, 'SKILL.md'), 'utf-8');
      const report = checkSkillContract(name, content);
      // Surface the exact rule + line on failure so a regression is immediately actionable.
      const detail = report.violations.map((v) => `  ${v.rule} @L${v.lineNumber}: ${v.evidence}`).join('\n');
      expect(report.pass, `${name} tripped contract rules:\n${detail}`).toBe(true);
    });
  }
});

describe('checkSkillContract — synthetic rule detection', () => {
  const ruleIds = (content: string): readonly string[] =>
    checkSkillContract('synthetic', content).violations.map((v) => v.rule);

  it('S1 — flags routing output to a channel other than signals.json', () => {
    expect(ruleIds('- Write result to result.json when done.')).toContain('S1');
    expect(ruleIds('1. Print JSON to stdout for the harness to parse.')).toContain('S1');
    expect(ruleIds('- Define your own output schema for the response.')).toContain('S1');
  });

  it('S2 — flags git mutation commands but allows orientation reads', () => {
    expect(ruleIds('- Run `git commit -m "wip"` after each change.')).toContain('S2');
    expect(ruleIds('1. git push to the remote when complete.')).toContain('S2');
    // git log / status / diff for orientation are not mutations → no S2.
    expect(ruleIds('- Run `git log` and `git status` to orient yourself.')).not.toContain('S2');
  });

  it('S3 — flags separate-PR / branch-per-change advice', () => {
    expect(ruleIds('- Open a separate PR for each task.')).toContain('S3');
    expect(ruleIds('1. Create a new pull request per change.')).toContain('S3');
  });

  it('S4 — flags hardcoded package-manager command literals', () => {
    expect(ruleIds('- Run `pnpm test` to verify your changes.')).toContain('S4');
    expect(ruleIds('1. npm install the new dependency.')).toContain('S4');
    expect(ruleIds('- Run `go test ./...` before signalling.')).toContain('S4');
  });

  it('S5 — flags spawning subagents / new provider sessions', () => {
    expect(ruleIds('- Spawn a subagent to handle the refactor.')).toContain('S5');
    expect(ruleIds('1. Start a new session for the second half.')).toContain('S5');
  });

  it('S6 — flags self-owned verify verdict but allows incremental checks', () => {
    expect(ruleIds('- Run the full suite and make sure it passes before signalling done.')).toContain('S6');
    expect(ruleIds('1. You own the green build, so verify everything yourself.')).toContain('S6');
    // Incremental narrow checks after each change is the allowed posture → no S6.
    expect(ruleIds('- Run narrow checks after each change to catch regressions at the seam.')).not.toContain('S6');
  });
});

describe('checkSkillContract — negation demotion', () => {
  it('demotes a forbidden pattern preceded by a negation keyword (anti-pattern prose)', () => {
    const cases = [
      '- Never run `git commit` yourself; the harness owns git.',
      "- Don't open a separate PR for each change.",
      '- Avoid printing JSON to stdout — use signals.json.',
      '- Do not spawn a subagent for this work.',
      '- You must not run `pnpm test` directly; rely on the gate.',
    ];
    for (const line of cases) {
      const report = checkSkillContract('synthetic', line);
      expect(report.pass, `expected demotion for: ${line}`).toBe(true);
    }
  });

  it('does NOT demote when the negation follows the forbidden pattern', () => {
    // "git push, but never to main" — the imperative still stands.
    expect(checkSkillContract('synthetic', '- Run git push, but never to a protected branch.').pass).toBe(false);
  });
});

describe('checkSkillContract — line classification scoping', () => {
  it('treats fenced code-block lines as imperative instructions', () => {
    const content = ['Some prose.', '```bash', 'git commit -m "x"', '```'].join('\n');
    expect(ruleIdsOf(content)).toContain('S2');
  });

  it('ignores the fence delimiter lines themselves', () => {
    const content = ['```', 'plain text inside fence', '```'].join('\n');
    expect(checkSkillContract('synthetic', content).pass).toBe(true);
  });

  it('skips free prose (non-list, non-fenced) even when it names a forbidden pattern', () => {
    // Descriptive prose mentioning git commit is fine — it is not a list/fenced instruction.
    const content = 'The harness runs git commit for you after each task.';
    expect(checkSkillContract('synthetic', content).pass).toBe(true);
  });

  it('skips blockquote lines (quoted source / anti-pattern prose)', () => {
    const content = '> The harness will git push on your behalf when the task settles.';
    expect(checkSkillContract('synthetic', content).pass).toBe(true);
  });

  it('reports the correct 1-based line number and clipped evidence', () => {
    const content = ['line one', 'line two', '- git push to origin now'].join('\n');
    const report = checkSkillContract('synthetic', content);
    const s2 = report.violations.find((v) => v.rule === 'S2');
    expect(s2?.lineNumber).toBe(3);
    expect(s2?.evidence.length).toBeLessThanOrEqual(120);
    expect(s2?.evidence).toContain('git push');
  });
});

const ruleIdsOf = (content: string): readonly string[] =>
  checkSkillContract('synthetic', content).violations.map((v) => v.rule);
