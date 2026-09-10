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

  it('S7 — flags angle-bracket signal tag syntax the harness never parses', () => {
    expect(ruleIds('- Emit `<task-complete>` once the acceptance criteria are met.')).toContain('S7');
    expect(ruleIds('1. Surface it as a `<note>` signal.')).toContain('S7');
    expect(ruleIds('- Record it as a `<learning>` signal so it persists.')).toContain('S7');
    expect(ruleIds('- Write a `<decision>` signal when the approach changes.')).toContain('S7');
    expect(ruleIds('- Surface the blocker via `<task-blocked>` rather than retrying.')).toContain('S7');
    expect(ruleIds('- Confirm with a `<task-verified>` signal before completing.')).toContain('S7');
    // The real contract — a `note` signal written into signals.json, no angle brackets — must
    // not itself trip the rule that exists to ban the angle-bracket syntax.
    expect(ruleIds('- Surface the conflict as a `note` signal in `signals.json` rather than guessing.')).not.toContain(
      'S7'
    );
  });

  it('S7 — a fenced JSON example of the real signals.json shape does not false-positive', () => {
    // Bundled skills legitimately show the real contract inside a fenced example; the
    // discriminant is a quoted string ("type": "note"), never an angle-bracket tag, so it must
    // stay clean under S7 even though fenced lines are otherwise scanned as instructions.
    const content = [
      'Here is the shape:',
      '```json',
      '{ "schemaVersion": 1, "signals": [{ "type": "note", "text": "hi" }] }',
      '```',
    ].join('\n');
    expect(ruleIds(content)).not.toContain('S7');
  });

  it('S7 — a fenced TS/JSX example with unrelated angle-bracket syntax does not false-positive', () => {
    // Real bundled skills show generics and JSX inside fenced examples — `Promise<Task>`,
    // `<EmptyState message="..." />`, `<input type="date">` — none of which name a real signal
    // kind. S7 must key on the specific signal-kind identifiers, not "any angle bracket".
    const content = [
      '```typescript',
      'export async function createTask(input: { title: string }): Promise<Task> {',
      '  return <EmptyState message="No data available for this period" />;',
      '}',
      '```',
      '- Native platform feature covers it? `<input type="date">` over a picker lib.',
    ].join('\n');
    expect(ruleIds(content)).not.toContain('S7');
  });

  it('S7 — catches the continuation line of a hard-wrapped bullet (not just the opening line)', () => {
    // The bundled skills are hand-wrapped at ~110 chars, so the tag frequently lands on the
    // second physical line of a bullet — a line classifyLine sees as free prose, not a list item.
    const content = ['- Surface it to the operator', '  as a `<note>` signal.'].join('\n');
    expect(ruleIds(content)).toContain('S7');
  });

  it('S7 — catches a free-prose sentence naming a tag (not a list item or fenced code)', () => {
    expect(ruleIds('Before emitting `<task-complete>`, confirm the acceptance criteria are met.')).toContain('S7');
  });

  it('S7 — catches the self-closing tag form', () => {
    expect(ruleIds('- Emit `<task-complete/>` when done.')).toContain('S7');
  });

  it('S7 — catches a tag carrying an attribute', () => {
    expect(ruleIds('- Surface it as `<note severity="minor">` in the output.')).toContain('S7');
  });

  it('S7 — catches real signal kinds beyond the original six', () => {
    // `change`, `evaluation`, `commit-message` and `task-plan` are real discriminants under
    // src/integration/ai/contract/_engine/signals/ — an author mistyping any of them as a tag
    // teaches the same false contract as `<note>` does.
    expect(ruleIds('- Record it as a `<change>` signal.')).toContain('S7');
    expect(ruleIds('- Encode the verdict as an `<evaluation>` signal.')).toContain('S7');
    expect(ruleIds('- Write a `<commit-message>` signal for the PR body.')).toContain('S7');
    expect(ruleIds('- Draft the steps as a `<task-plan>` signal.')).toContain('S7');
  });

  it('S7 — negation still demotes an angle-bracket tag in anti-pattern prose', () => {
    expect(
      checkSkillContract('synthetic', '- Never write `<task-complete>` yourself; write a plain signal.').pass
    ).toBe(true);
  });
});

describe('checkSkillContract — S7 regression fixtures (pre-fix bundled skill wording)', () => {
  // These lines are the literal offending text each bundled skill carried before the tag-syntax
  // fix (see `git diff origin/main` on src/integration/ai/skills/bundled/*/SKILL.md at the time
  // of that change). checkSkillContract's S7 rule previously ran only on list-marker lines, so
  // four of these — the ones on a free-prose or bullet-continuation line — tripped nothing at
  // all, and the contract test green-lit the exact text the fix was written to remove. Each case
  // here must independently trip S7 so the guard cannot regress to that state undetected.
  const preFixLines: Record<string, string> = {
    'ralphctl-alignment (continuation line — previously ZERO violations)':
      "  arbiter; if your read of it differs from what's written, surface the conflict in a `<note>` rather than\n  guessing.",
    'ralphctl-cherny-workflow (free-prose + checklist line)':
      '- When no automated check exists for a step, create the smallest one that would fail if the step were wrong — or state explicitly in a `<note>` signal that the step is unverified and why.',
    'ralphctl-code-review-and-quality (bulleted instruction)':
      '- Use `<decision>` when a Critical or Major finding changes the approach — record what was found and why\n  the current direction was adjusted.',
    'ralphctl-debugging-and-error-recovery (checklist line)':
      '- [ ] Root cause is identified and documented (in a `<note>` or `<decision>` signal if non-obvious).',
    'ralphctl-iterative-review (continuation line — previously ZERO violations)':
      'after the whole diff. Re-read your own diff once before signalling `<task-complete>`. You are the cheapest\nreviewer the change ever gets.',
    'ralphctl-karpathy-guidelines (free-prose line)':
      '- When the task is ambiguous, name the ambiguity before acting. With an interactive channel, ask; without one, state the interpretation you chose and why in a `<decision>` or `<note>` signal, then proceed with the least-surprising reading.',
    'ralphctl-ponytail (bulleted instruction)':
      '- Complex request? Ship the lazy version and question the rest in a `<note>` signal: "Did X; Y covers it. Need full X? Say so." Never stall on an answer you can default.',
    'ralphctl-surgical-simplicity (continuation line — previously ZERO violations)':
      "   comment — surface it as a `<note>` signal and leave it untouched.** The harness captures the note in the\n   sprint's progress journal",
    'ralphctl-test-driven-development (free-prose line — previously ZERO violations)':
      'Before emitting `<task-complete>`, confirm:',
  };

  for (const [label, content] of Object.entries(preFixLines)) {
    it(`catches ${label}`, () => {
      const report = checkSkillContract('synthetic', content);
      expect(
        report.violations.some((v) => v.rule === 'S7'),
        `expected S7 for:\n${content}`
      ).toBe(true);
    });
  }
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
