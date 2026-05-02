import { describe, expect, it } from 'vitest';

import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import type {
  AgentsMdProposalSignal,
  CheckScriptDiscoverySignal,
  DimensionScore,
  EvaluationSignal,
  HarnessSignal,
  NoteSignal,
  ProgressSignal,
  SetupScriptSignal,
  SkillSuggestionsSignal,
  TaskBlockedSignal,
  TaskCompleteSignal,
  TaskVerifiedSignal,
  VerifyScriptSignal,
} from './harness-signal.ts';

const NOW = IsoTimestamp.now();

/**
 * Exhaustive switch over every signal variant. Returns the variant tag so
 * tests can assert the narrowing actually fires. Adding a new variant to
 * `HarnessSignal` without handling it here is a compile error at the
 * `_exhaustive: never` line — the whole point of the discriminated union.
 */
function describeSignal(signal: HarnessSignal): string {
  switch (signal.type) {
    case 'progress':
      return signal.summary;
    case 'evaluation':
      return signal.status;
    case 'task-complete':
      return 'task-complete';
    case 'task-verified':
      return signal.output;
    case 'task-blocked':
      return signal.reason;
    case 'note':
      return signal.text;
    case 'check-script-discovery':
      return signal.command;
    case 'agents-md-proposal':
      return signal.content;
    case 'setup-script':
      return signal.command;
    case 'verify-script':
      return signal.command;
    case 'skill-suggestions':
      return signal.names.join(',');
    default: {
      const _exhaustive: never = signal;
      return _exhaustive;
    }
  }
}

describe('HarnessSignal — discriminated union', () => {
  it('narrows ProgressSignal and exposes summary + files', () => {
    const signal: ProgressSignal = {
      type: 'progress',
      summary: 'wrote two files',
      files: ['a.ts', 'b.ts'],
      timestamp: NOW,
    };
    expect(describeSignal(signal)).toBe('wrote two files');
    expect(signal.files).toStrictEqual(['a.ts', 'b.ts']);
  });

  it('allows ProgressSignal without files (optional field)', () => {
    const signal: ProgressSignal = {
      type: 'progress',
      summary: 'no files yet',
      timestamp: NOW,
    };
    expect(describeSignal(signal)).toBe('no files yet');
    expect(signal.files).toBeUndefined();
  });

  it('narrows EvaluationSignal and surfaces status + dimensions', () => {
    const dimensions: DimensionScore[] = [
      { dimension: 'correctness', passed: true, finding: 'looks fine' },
      { dimension: 'safety', passed: false, finding: 'missing guard' },
    ];
    const signal: EvaluationSignal = {
      type: 'evaluation',
      status: 'failed',
      dimensions,
      critique: 'rewrite the guard',
      timestamp: NOW,
    };
    expect(describeSignal(signal)).toBe('failed');
    expect(signal.dimensions).toHaveLength(2);
    expect(signal.critique).toBe('rewrite the guard');
  });

  it('allows malformed EvaluationSignal with empty dimensions', () => {
    const signal: EvaluationSignal = {
      type: 'evaluation',
      status: 'malformed',
      dimensions: [],
      timestamp: NOW,
    };
    expect(signal.status).toBe('malformed');
    expect(signal.dimensions).toStrictEqual([]);
    expect(signal.critique).toBeUndefined();
  });

  it('narrows TaskCompleteSignal — minimal lifecycle marker', () => {
    const signal: TaskCompleteSignal = {
      type: 'task-complete',
      timestamp: NOW,
    };
    expect(describeSignal(signal)).toBe('task-complete');
  });

  it('narrows TaskVerifiedSignal and surfaces output', () => {
    const signal: TaskVerifiedSignal = {
      type: 'task-verified',
      output: 'tests green',
      timestamp: NOW,
    };
    expect(describeSignal(signal)).toBe('tests green');
  });

  it('narrows TaskBlockedSignal and surfaces reason', () => {
    const signal: TaskBlockedSignal = {
      type: 'task-blocked',
      reason: 'waiting on upstream PR',
      timestamp: NOW,
    };
    expect(describeSignal(signal)).toBe('waiting on upstream PR');
  });

  it('narrows NoteSignal and surfaces text', () => {
    const signal: NoteSignal = {
      type: 'note',
      text: 'observed regression in prod',
      timestamp: NOW,
    };
    expect(describeSignal(signal)).toBe('observed regression in prod');
  });

  it('narrows CheckScriptDiscoverySignal (setup-time only)', () => {
    const signal: CheckScriptDiscoverySignal = {
      type: 'check-script-discovery',
      command: 'pnpm typecheck && pnpm test',
      timestamp: NOW,
    };
    expect(describeSignal(signal)).toBe('pnpm typecheck && pnpm test');
  });

  it('narrows AgentsMdProposalSignal (setup-time only)', () => {
    const signal: AgentsMdProposalSignal = {
      type: 'agents-md-proposal',
      content: '# Project\n\nbody',
      timestamp: NOW,
    };
    expect(describeSignal(signal)).toBe('# Project\n\nbody');
  });

  it('narrows SetupScriptSignal (onboarding-time only)', () => {
    const signal: SetupScriptSignal = {
      type: 'setup-script',
      command: 'pnpm install',
      timestamp: NOW,
    };
    expect(describeSignal(signal)).toBe('pnpm install');
  });

  it('narrows VerifyScriptSignal (onboarding-time only)', () => {
    const signal: VerifyScriptSignal = {
      type: 'verify-script',
      command: 'pnpm typecheck && pnpm test',
      timestamp: NOW,
    };
    expect(describeSignal(signal)).toBe('pnpm typecheck && pnpm test');
  });

  it('narrows SkillSuggestionsSignal — list of kebab-case names', () => {
    const signal: SkillSuggestionsSignal = {
      type: 'skill-suggestions',
      names: ['react-patterns', 'nextjs-app-router'],
      timestamp: NOW,
    };
    expect(describeSignal(signal)).toBe('react-patterns,nextjs-app-router');
    expect(signal.names).toHaveLength(2);
  });

  it('allows SkillSuggestionsSignal with empty names', () => {
    const signal: SkillSuggestionsSignal = {
      type: 'skill-suggestions',
      names: [],
      timestamp: NOW,
    };
    expect(signal.names).toStrictEqual([]);
  });

  it('handles every variant in a single mixed array', () => {
    const signals: HarnessSignal[] = [
      { type: 'progress', summary: 's', timestamp: NOW },
      { type: 'evaluation', status: 'passed', dimensions: [], timestamp: NOW },
      { type: 'task-complete', timestamp: NOW },
      { type: 'task-verified', output: 'o', timestamp: NOW },
      { type: 'task-blocked', reason: 'r', timestamp: NOW },
      { type: 'note', text: 't', timestamp: NOW },
      { type: 'check-script-discovery', command: 'c', timestamp: NOW },
      { type: 'agents-md-proposal', content: 'a', timestamp: NOW },
      { type: 'setup-script', command: 'setup', timestamp: NOW },
      { type: 'verify-script', command: 'verify', timestamp: NOW },
      { type: 'skill-suggestions', names: ['x'], timestamp: NOW },
    ];
    const tags = signals.map((s) => describeSignal(s));
    expect(tags).toStrictEqual(['s', 'passed', 'task-complete', 'o', 'r', 't', 'c', 'a', 'setup', 'verify', 'x']);
  });

  it('uses IsoTimestamp (not Date) for all variants — assignment compiles', () => {
    // This test is mostly compile-time: if `timestamp` were `Date`, passing
    // an `IsoTimestamp` (a branded string) would fail to type-check.
    const ts: IsoTimestamp = NOW;
    const signal: ProgressSignal = { type: 'progress', summary: 'x', timestamp: ts };
    expect(typeof signal.timestamp).toBe('string');
    expect(signal.timestamp).toBe(NOW);
  });
});
