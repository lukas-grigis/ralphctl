import { describe, expect, it } from 'vitest';

import {
  checkPlanUseCase,
  type PlanCheckFinding,
  type PlanCheckFindingKind,
  renderPlanCheckFinding,
  SEVERITY_BY_KIND,
  severityOfFinding,
} from '@src/business/sprint/check-plan.ts';
import { createProject } from '@src/domain/entity/project.ts';
import { createRepository } from '@src/domain/entity/repository.ts';
import type { Repository, VerifyGate } from '@src/domain/entity/repository.ts';
import { normalizeVerifyGates } from '@src/business/task/run-verify-script.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { TodoTask, VerificationCriterion } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import {
  absolutePath,
  FIXED_PROJECT_ID,
  FIXED_REPOSITORY_ID,
  makeProject,
  makeTodoTask,
  repositoryId,
} from '@tests/fixtures/domain.ts';

/**
 * The critic runs over the RESOLVED `TodoTask[]`, so several `error`-tier cases are unreachable
 * through the plan parser today (it rejects them first). Those tasks are therefore assembled by
 * overriding fields on a valid fixture task — that is exactly the "future non-parser producer"
 * the defence-in-depth tier exists for.
 */
const withCriteria = (criteria: readonly VerificationCriterion[], overrides: Partial<TodoTask> = {}): TodoTask => ({
  ...makeTodoTask(),
  verificationCriteria: criteria,
  ...overrides,
});

const auto = (command: string, id = 'C1'): VerificationCriterion => ({
  id,
  assertion: 'the check passes',
  check: 'auto',
  command,
});

const manual = (id = 'C1'): VerificationCriterion => ({ id, assertion: 'looks right', check: 'manual' });

/** A project whose single repository advertises a runnable check (gates the `no-auto-criterion` rule). */
const projectWithVerifyScript = (): Project => {
  const repo = createRepository({
    id: FIXED_REPOSITORY_ID,
    path: absolutePath('/tmp/ralph/check-plan-repo'),
    name: 'main-repo',
    verifyScript: 'make check',
  });
  if (!repo.ok) throw new Error('fixture setup failed');
  return projectWith(repo.value);
};

const projectWith = (repo: Repository): Project => {
  const project = createProject({
    id: FIXED_PROJECT_ID,
    displayName: 'Demo Project',
    description: 'fixture project',
    repositories: [repo],
  });
  if (!project.ok) throw new Error('fixture setup failed');
  return project.value;
};

const kindsOf = (tasks: readonly TodoTask[], project: Project = makeProject()): readonly PlanCheckFindingKind[] => {
  const report = checkPlanUseCase({ project, tasks });
  expect(report.ok).toBe(true);
  if (!report.ok) return [];
  return report.value.findings.map((f) => f.kind);
};

describe('checkPlanUseCase — clean plan', () => {
  it('returns an empty report for a well-formed plan', () => {
    const report = checkPlanUseCase({ project: makeProject(), tasks: [makeTodoTask()] });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.findings).toEqual([]);
    expect(report.value.errorCount).toBe(0);
    expect(report.value.warningCount).toBe(0);
  });

  it('is infallible — an utterly broken plan still returns Result.ok', () => {
    const broken = withCriteria([], { repositoryId: repositoryId('01900000-0000-7000-8000-0000000000ff') });
    const report = checkPlanUseCase({ project: makeProject(), tasks: [broken] });
    expect(report.ok).toBe(true);
  });
});

describe('checkPlanUseCase — structural (error tier)', () => {
  it('reports a self-edge through the canonical graph-issue phrasing', () => {
    const task = makeTodoTask();
    const selfDep: TodoTask = { ...task, dependsOn: [task.id] };
    const report = checkPlanUseCase({ project: makeProject(), tasks: [selfDep] });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.findings[0]?.kind).toBe('task-graph');
    expect(report.value.findings[0]?.detail).toContain('depends on itself');
  });

  it('reports a dangling dependency', () => {
    const missing = '01900000-0000-7000-8000-0000000000aa' as TaskId;
    const task: TodoTask = { ...makeTodoTask(), dependsOn: [missing] };
    expect(kindsOf([task])).toEqual(['task-graph']);
  });

  it('reports a dependency cycle', () => {
    const a = makeTodoTask({ name: 'a', order: 1 });
    const b = makeTodoTask({ name: 'b', order: 2 });
    const linked: readonly TodoTask[] = [
      { ...a, dependsOn: [b.id] },
      { ...b, dependsOn: [a.id] },
    ];
    const report = checkPlanUseCase({ project: makeProject(), tasks: linked });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.findings[0]?.detail).toContain('dependency cycle');
  });

  it('reports a repositoryId that is not on the project', () => {
    const stray: TodoTask = { ...makeTodoTask(), repositoryId: repositoryId('01900000-0000-7000-8000-0000000000bb') };
    expect(kindsOf([stray])).toContain('unknown-repository');
  });

  it('reports a task with zero verification criteria and suppresses the auto-coverage warning', () => {
    expect(kindsOf([withCriteria([])], projectWithVerifyScript())).toEqual(['no-criteria']);
  });

  it('reports an auto criterion whose command is blank', () => {
    expect(kindsOf([withCriteria([auto('   ')])])).toEqual(['auto-criterion-missing-command']);
  });
});

describe('checkPlanUseCase — command quality (warning tier)', () => {
  it.each([
    [
      "<project's test command scoped to tests/users/pagination.test.ts>",
      'the plan template scoped-test example, copied verbatim',
    ],
    ["<project's test command>", 'the pre-scoping plan template example'],
    ['pnpm test # TODO pick the real one', 'a leftover TODO token'],
    ['pnpm test ...', 'an elided command'],
    ['cat src/.../x', 'an elided path'],
  ])('flags %j as a placeholder command', (command) => {
    expect(kindsOf([withCriteria([auto(command)])])).toContain('placeholder-command');
  });

  it('does not double-report a placeholder as prose', () => {
    expect(kindsOf([withCriteria([auto("<project's test command>")])])).toEqual(['placeholder-command']);
  });

  it.each(['Run the tests.', 'Manually, check the output', 'Does the button work?'])(
    'flags %j as a prose command',
    (command) => {
      expect(kindsOf([withCriteria([auto(command)])])).toEqual(['prose-command']);
    }
  );

  it.each([
    'git add .',
    'docker build .',
    'pnpm vitest run src/a.test.ts',
    'node -e "process.exit(0)"',
    './scripts/verify.sh --strict',
    'make check',
    'go test ./...',
    'go vet ./pkg/...',
    'CI=1 pnpm test',
    '(cd web-ui && pnpm check)',
    '(cd services && mvn verify) && (cd web-ui && pnpm check)',
    '{ make build; make test; }',
  ])('leaves %j alone', (command) => {
    expect(kindsOf([withCriteria([auto(command)])])).toEqual([]);
  });

  it('flags a command that spans multiple lines', () => {
    expect(kindsOf([withCriteria([auto('pnpm build\npnpm test')])])).toEqual(['multi-line-command']);
  });

  it('flags a duplicate criterion id within one task', () => {
    const kinds = kindsOf([withCriteria([manual('C2'), manual('C2')])]);
    expect(kinds).toEqual(['duplicate-criterion-id']);
  });

  it('flags an all-manual task when its repository exposes a verifyScript', () => {
    expect(kindsOf([withCriteria([manual()])], projectWithVerifyScript())).toEqual(['no-auto-criterion']);
  });

  it('flags an all-manual task when its repository exposes verifyGates', () => {
    const repo = createRepository({
      id: FIXED_REPOSITORY_ID,
      path: absolutePath('/tmp/ralph/check-plan-gated'),
      name: 'main-repo',
      verifyGates: [{ pathPrefix: '', command: 'make check' }],
    });
    if (!repo.ok) throw new Error('fixture setup failed');
    expect(kindsOf([withCriteria([manual()])], projectWith(repo.value))).toEqual(['no-auto-criterion']);
  });

  it('stays quiet on an all-manual task when the repository exposes no check command', () => {
    // `makeProject()`'s repository has neither verifyScript nor verifyGates.
    expect(kindsOf([withCriteria([manual()])])).toEqual([]);
  });
});

describe('checkPlanUseCase — verify-gate-criterion', () => {
  /** The incident: the planner's auto criterion re-ran the repo's whole post-task verify gate. */
  const INCIDENT_GATE = '(cd services && mvn verify) && (cd web-ui && pnpm check)';

  const repoWith = (
    gate: { readonly verifyScript?: string; readonly verifyGates?: readonly VerifyGate[] },
    name = 'check-plan-gate'
  ): Repository => {
    const repo = createRepository({
      id: FIXED_REPOSITORY_ID,
      path: absolutePath(`/tmp/ralph/${name}`),
      name: 'main-repo',
      ...gate,
    });
    if (!repo.ok) throw new Error('fixture setup failed');
    return repo.value;
  };

  it('flags an auto criterion whose command equals the verifyScript', () => {
    const project = projectWith(repoWith({ verifyScript: INCIDENT_GATE }));
    const report = checkPlanUseCase({ project, tasks: [withCriteria([auto(INCIDENT_GATE, 'C2')])] });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.findings).toEqual([
      expect.objectContaining({ kind: 'verify-gate-criterion', criterionId: 'C2' }),
    ]);
    expect(report.value.warningCount).toBe(1);
    expect(report.value.findings[0]?.detail).toContain("repeats the repository's post-task verify gate");
  });

  it('flags the gate even when the criterion differs only in whitespace', () => {
    const project = projectWith(repoWith({ verifyScript: INCIDENT_GATE }));
    const spaced = '  (cd services &&   mvn verify)\t&&  (cd web-ui && pnpm check) ';
    expect(kindsOf([withCriteria([auto(spaced)])], project)).toEqual(['verify-gate-criterion']);
  });

  it('flags a match against one of several verifyGates', () => {
    const project = projectWith(
      repoWith({
        verifyGates: [
          { pathPrefix: 'services', command: '(cd services && mvn verify)' },
          { pathPrefix: 'web-ui', command: '(cd web-ui && pnpm check)' },
        ],
      })
    );
    expect(kindsOf([withCriteria([auto('(cd web-ui && pnpm check)')])], project)).toEqual(['verify-gate-criterion']);
  });

  it.each([
    'cd web-ui && pnpm test:e2e',
    'cd web-ui && pnpm exec playwright test e2e/pagination.spec.ts',
    '(cd services && mvn verify)',
  ])('stays quiet for %j, which is not the gate verbatim', (command) => {
    const project = projectWith(repoWith({ verifyScript: INCIDENT_GATE }));
    expect(kindsOf([withCriteria([auto(command)])], project)).toEqual([]);
  });

  it('stays quiet when a gate-like command is a prefix of a longer one', () => {
    const project = projectWith(repoWith({ verifyScript: 'pnpm test' }));
    expect(kindsOf([withCriteria([auto('pnpm test:unit')])], project)).toEqual([]);
  });

  it('stays quiet for manual criteria', () => {
    const project = projectWith(repoWith({ verifyScript: INCIDENT_GATE }));
    const manualWithGate: VerificationCriterion = {
      id: 'C1',
      assertion: 'the whole suite is green',
      check: 'manual',
      command: INCIDENT_GATE,
    };
    // A sibling auto criterion keeps the unrelated no-auto-criterion warning out of the picture.
    expect(kindsOf([withCriteria([manualWithGate, auto('make lint', 'C2')])], project)).toEqual([]);
  });

  it('stays quiet when the repository has no verify gate', () => {
    // `makeProject()`'s repository has neither verifyScript nor verifyGates.
    expect(kindsOf([withCriteria([auto(INCIDENT_GATE)])])).toEqual([]);
  });

  it('compares against verifyGates, not a stale verifyScript, when both are set', () => {
    const project = projectWith(
      repoWith({ verifyScript: INCIDENT_GATE, verifyGates: [{ pathPrefix: '', command: 'make check' }] })
    );
    expect(kindsOf([withCriteria([auto(INCIDENT_GATE)])], project)).toEqual([]);
    expect(kindsOf([withCriteria([auto('make check')])], project)).toEqual(['verify-gate-criterion']);
  });

  // check-plan cannot import `normalizeVerifyGates` (sibling-business fence), so it restates the
  // gate-precedence rule. Pin the copy to the canonical helper: every command the post-task
  // verify gate would run is flagged, and nothing else is.
  it.each<[string, { readonly verifyScript?: string; readonly verifyGates?: readonly VerifyGate[] }]>([
    ['verifyScript only', { verifyScript: '  make check  ' }],
    [
      'verifyGates only',
      {
        verifyGates: [
          { pathPrefix: 'api', command: 'make api' },
          { pathPrefix: '', command: 'make all' },
        ],
      },
    ],
    ['both — gates win', { verifyScript: 'make legacy', verifyGates: [{ pathPrefix: '', command: 'make check' }] }],
    ['neither', {}],
  ])('flags exactly the commands normalizeVerifyGates yields (%s)', (_label, gate) => {
    const repo = repoWith(gate);
    const gateCommands = normalizeVerifyGates(repo.verifyScript, repo.verifyGates).map((g) => g.command);
    const project = projectWith(repo);
    for (const command of ['make check', 'make legacy', 'make api', 'make all']) {
      const flagged = kindsOf([withCriteria([auto(command)])], project).includes('verify-gate-criterion');
      expect(flagged, command).toBe(gateCommands.includes(command));
    }
  });

  it('stays quiet when the task points at an unknown repository', () => {
    const project = projectWith(repoWith({ verifyScript: 'make check' }));
    const stray = withCriteria([auto('make check')], {
      repositoryId: repositoryId('01900000-0000-7000-8000-0000000000dd'),
    });
    expect(kindsOf([stray], project)).toEqual(['unknown-repository']);
  });
});

describe('checkPlanUseCase — report shape', () => {
  it('tallies errors and warnings separately', () => {
    const bad = withCriteria([auto(''), auto('Run the tests.', 'C2'), manual('C2')]);
    const report = checkPlanUseCase({ project: makeProject(), tasks: [bad] });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.errorCount).toBe(1);
    expect(report.value.warningCount).toBe(2);
    expect(report.value.errorCount + report.value.warningCount).toBe(report.value.findings.length);
  });

  it('orders findings graph-first, then tasks by order ASC, then criteria in array order', () => {
    const first = withCriteria([auto('Run the tests.', 'C1'), auto('pnpm test ...', 'C2')], {
      name: 'second-by-order',
      order: 2,
    });
    const second = withCriteria([], { name: 'first-by-order', order: 1 });
    const dangling: TodoTask = { ...second, dependsOn: ['01900000-0000-7000-8000-0000000000cc' as TaskId] };
    const report = checkPlanUseCase({ project: makeProject(), tasks: [first, dangling] });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.findings.map((f) => f.kind)).toEqual([
      'task-graph',
      'no-criteria',
      'prose-command',
      'placeholder-command',
    ]);
  });
});

describe('severity + rendering', () => {
  it('assigns a severity to every finding kind', () => {
    const kinds = Object.keys(SEVERITY_BY_KIND) as readonly PlanCheckFindingKind[];
    expect(kinds).toHaveLength(10);
    expect(SEVERITY_BY_KIND['verify-gate-criterion']).toBe('warning');
    for (const kind of kinds) expect(['error', 'warning']).toContain(SEVERITY_BY_KIND[kind]);
  });

  it('renders a graph finding without a task location', () => {
    const finding: PlanCheckFinding = { kind: 'task-graph', detail: 'task A depends on itself' };
    expect(severityOfFinding(finding)).toBe('error');
    expect(renderPlanCheckFinding(finding)).toBe('error: plan graph — task A depends on itself');
  });

  it('renders a criterion finding with task order, name and criterion id', () => {
    const finding: PlanCheckFinding = {
      kind: 'prose-command',
      detail: 'command reads as prose',
      taskOrder: 3,
      taskName: 'Wire UI button',
      criterionId: 'C2',
      command: 'Run the tests.',
    };
    expect(severityOfFinding(finding)).toBe('warning');
    expect(renderPlanCheckFinding(finding)).toBe("warning: task 3 'Wire UI button' [C2] — command reads as prose");
  });
});
