import type { Task } from '@src/domain/entity/task.ts';

/**
 * Coarse classification of what a task *does*, derived from its prose. Used to bucket the
 * learnings a task produces so the distillation step can group "what we learned
 * fixing bugs" separately from "what we learned writing docs" without the operator tagging
 * each task by hand.
 *
 * `'other'` is the explicit fallback — a task whose prose matches no known keyword is not a
 * failure, it just isn't confidently classifiable.
 */
export type TaskKind = 'feature' | 'bugfix' | 'refactor' | 'test' | 'docs' | 'chore' | 'other';

/**
 * Ordered keyword table. Earlier entries win on a tie — a task that mentions both "fix" and
 * "refactor" is classified `bugfix`, because the operator's headline intent is usually the
 * bug. Order therefore encodes precedence, not just grouping.
 *
 * Keywords are matched as whole words (word-boundary regex) against the lower-cased
 * `name + description` so "feature" doesn't fire on "featured" and "test" doesn't fire on
 * "fastest". This is an acknowledged heuristic — it reads only the task's own prose and makes
 * no claim about the diff that results.
 */
const KEYWORDS: ReadonlyArray<readonly [TaskKind, readonly string[]]> = [
  ['bugfix', ['fix', 'bug', 'bugfix', 'patch', 'hotfix', 'regression', 'defect', 'crash', 'broken']],
  ['test', ['test', 'tests', 'testing', 'spec', 'specs', 'coverage', 'fixture', 'fixtures']],
  ['docs', ['doc', 'docs', 'documentation', 'readme', 'changelog', 'comment', 'comments', 'docstring']],
  ['refactor', ['refactor', 'refactoring', 'cleanup', 'restructure', 'rename', 'extract', 'simplify', 'tidy']],
  ['chore', ['chore', 'bump', 'upgrade', 'dependency', 'dependencies', 'deps', 'config', 'lint', 'format', 'ci']],
  ['feature', ['feature', 'add', 'implement', 'introduce', 'support', 'new', 'create', 'build']],
];

/** Keyword scan shared by both classifiers — first matching bucket in table order wins. */
const classifyProse = (prose: string): TaskKind => {
  const haystack = prose.toLowerCase();

  for (const [kind, words] of KEYWORDS) {
    for (const word of words) {
      const pattern = new RegExp(`\\b${word}\\b`);
      if (pattern.test(haystack)) return kind;
    }
  }

  return 'other';
};

/**
 * Classify a {@link Task} into a {@link TaskKind} by scanning its `name` and `description`
 * for known keywords. Returns `'other'` when nothing matches.
 *
 * Pure — reads only the task's own prose, performs no I/O, mutates nothing.
 */
export const deriveTaskKind = (task: Task): TaskKind => classifyProse(`${task.name} ${task.description ?? ''}`);

/**
 * Headline-first variant of {@link deriveTaskKind}: classify the task's `name` alone, and fall
 * back to the full `name + description` scan only when the name matches no keyword. The name
 * states the operator's intent; the description routinely mentions "fix" / "broken" in passing
 * ("…and fix any lint errors"), which the full scan's bugfix-first precedence turns into a
 * bugfix verdict. Used where a false `'bugfix'` costs a whole AI spawn (the reproduce gate);
 * learning-ledger bucketing keeps {@link deriveTaskKind}, whose verdict is hashed into record ids.
 */
export const deriveHeadlineTaskKind = (task: Task): TaskKind => {
  const fromName = classifyProse(task.name);
  return fromName !== 'other' ? fromName : deriveTaskKind(task);
};
