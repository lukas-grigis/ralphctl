/**
 * Shared demo-workspace seeder — the single place that builds the "hello-python" mock project
 * (one project, one throwaway git repo, three sprints each parked in exactly the state one flow
 * expects). `scripts/seed-mock.ts` (contributor-only `pnpm mock`) and `ralphctl demo` (shipped
 * production command) both delegate here so the two surfaces can never drift (#228).
 *
 * Deliberately I/O-parameterised: no `process.env` reads, no direct `node:child_process` calls.
 * Git operations go through the injected {@link RunCommand} port (`-C <dir>` instead of a `cwd`
 * option — `RunCommand` doesn't carry one), and the sandbox marker file goes through the
 * injected {@link WriteFile} port so the write is atomic like every other persisted artefact.
 *
 * Seeded sprints (one per pre-flow state):
 *   1. "ready to refine"    — draft sprint, 1 pending ticket               → run Refine
 *   2. "ready to plan"      — draft sprint, 1 approved ticket              → run Plan
 *   3. "ready to implement" — planned sprint, 1 approved ticket + 1 task   → run Implement
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { ensureStorageRoots, storagePathsFromRoot } from '@src/application/bootstrap/storage-paths.ts';
import type { RunCommand } from '@src/integration/io/run-command.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';

import { createProject, type Project } from '@src/domain/entity/project.ts';
import { createRepository, type Repository } from '@src/domain/entity/repository.ts';
import { approveTicketRequirements, createTicket } from '@src/domain/entity/ticket.ts';
import { addTicket, createSprintWithExecution, planSprint } from '@src/domain/entity/sprint.ts';
import { createTask } from '@src/domain/entity/task-factory.ts';

import { createFsProjectRepository } from '@src/integration/persistence/project/repository.ts';
import { createFsSprintRepository } from '@src/integration/persistence/sprint/repository.ts';
import { createFsSprintExecutionRepository } from '@src/integration/persistence/sprint-execution/repository.ts';
import { createFsTaskRepository } from '@src/integration/persistence/task/repository.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { SprintExecutionRepository } from '@src/domain/repository/sprint/sprint-execution-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';

/** Marker file dropped at the sandbox root — `ralphctl demo` refuses to wipe-and-reseed any
 * directory that lacks this file, so pointing the command at an unrelated directory can't
 * destroy it. */
export const DEMO_MARKER_FILENAME = '.ralphctl-demo';

export interface SeedDemoWorkspaceDeps {
  readonly runCommand: RunCommand;
  readonly writeFile: WriteFile;
}

export interface SeedDemoWorkspaceInput {
  readonly homeDir: AbsolutePath;
  /** Short per-run token — keeps project / sprint / repo slugs distinct across reseeds. */
  readonly token: string;
}

export interface SeedDemoSprintSummary {
  readonly name: string;
  /** Human-readable pre-flow state, e.g. "draft — run Refine". */
  readonly state: string;
}

export interface SeedDemoSummary {
  readonly homeDir: AbsolutePath;
  readonly repoDir: AbsolutePath;
  readonly projectName: string;
  readonly sprints: readonly SeedDemoSprintSummary[];
}

/** Throws the DomainError itself so the top-level try/catch below can convert it to a `Result`
 * without losing type information — mirrors the leaf/use-case boundary pattern. */
const unwrap = <T>(r: Result<T, DomainError>): T => {
  if (!r.ok) throw r.error;
  return r.value as T;
};

const runGit = async (runCommand: RunCommand, repoDir: string, args: readonly string[]): Promise<void> => {
  const r = await runCommand('git', ['-C', repoDir, ...args]);
  if (!r.ok) {
    throw new StorageError({
      subCode: 'io',
      message: `git ${args.join(' ')} failed in ${repoDir}: ${r.stderr || `exit ${String(r.code)}`}`,
      path: repoDir,
    });
  }
};

const seedMockRepo = async (runCommand: RunCommand, repoDir: string): Promise<void> => {
  await fs.mkdir(repoDir, { recursive: true });
  await fs.writeFile(
    join(repoDir, 'hello.py'),
    '# Placeholder greeting — the implement sprint changes this to print "Hello, world!".\nprint("hi from the mock project")\n'
  );
  await fs.writeFile(
    join(repoDir, 'README.md'),
    '# hello-python (ralphctl demo)\n\nThrowaway project for exercising the refine / plan / implement flows.\n\nRun: `python3 hello.py`\n'
  );
  // Deterministic, throwaway identity — never a real ralphctl commit.
  await runGit(runCommand, repoDir, ['init', '--initial-branch=main']);
  await runGit(runCommand, repoDir, ['config', 'user.name', 'ralphctl demo']);
  await runGit(runCommand, repoDir, ['config', 'user.email', 'demo@ralphctl.local']);
  await runGit(runCommand, repoDir, ['add', '-A']);
  await runGit(runCommand, repoDir, ['commit', '-m', 'chore: scaffold hello-python demo']);
};

interface SeedRepos {
  readonly sprintRepo: SprintRepository;
  readonly executionRepo: SprintExecutionRepository;
  readonly taskRepo: TaskRepository;
}

/** Sprint 1 — ready to refine: draft + 1 pending ticket. */
const seedRefineSprint = async (repos: SeedRepos, project: Project, token: string): Promise<SeedDemoSprintSummary> => {
  const s1 = unwrap(createSprintWithExecution({ name: `ready to refine · ${token}`, projectId: project.id }));
  const s1Draft = unwrap(
    addTicket(
      s1.sprint,
      unwrap(
        createTicket({
          title: 'Greet the user by name',
          description: 'The greeting should address the person running the script. Details TBD — needs refinement.',
        })
      )
    )
  );
  unwrap(await repos.sprintRepo.save(s1Draft));
  unwrap(await repos.executionRepo.save(s1.execution));
  return { name: s1Draft.name, state: 'draft — run Refine' };
};

/** Sprint 2 — ready to plan: draft + 1 approved ticket. */
const seedPlanSprint = async (repos: SeedRepos, project: Project, token: string): Promise<SeedDemoSprintSummary> => {
  const s2 = unwrap(createSprintWithExecution({ name: `ready to plan · ${token}`, projectId: project.id }));
  const s2Ticket = unwrap(
    approveTicketRequirements(
      unwrap(createTicket({ title: 'Add a --name CLI argument to the greeting' })),
      [
        '## Requirements',
        '',
        '- Accept an optional `--name <value>` argument.',
        '- When provided, print `Hello, <value>!`.',
        '- When omitted, fall back to `Hello, world!`.',
        '- `python3 hello.py` must still exit 0 in both cases.',
      ].join('\n')
    )
  );
  const s2Draft = unwrap(addTicket(s2.sprint, s2Ticket));
  unwrap(await repos.sprintRepo.save(s2Draft));
  unwrap(await repos.executionRepo.save(s2.execution));
  return { name: s2Draft.name, state: 'draft (ticket approved) — run Plan' };
};

/** Sprint 3 — ready to implement: planned + 1 approved ticket + 1 task. */
const seedImplementSprint = async (
  repos: SeedRepos,
  project: Project,
  repo: Repository,
  token: string,
  now: ReturnType<typeof IsoTimestamp.now>
): Promise<SeedDemoSprintSummary> => {
  const s3 = unwrap(createSprintWithExecution({ name: `ready to implement · ${token}`, projectId: project.id }));
  const s3Ticket = unwrap(
    approveTicketRequirements(
      unwrap(createTicket({ title: 'Print "Hello, world!" from hello.py' })),
      [
        '## Requirements',
        '',
        '- `hello.py` prints exactly `Hello, world!` (followed by a newline).',
        '- `python3 hello.py` exits 0.',
      ].join('\n')
    )
  );
  const s3Draft = unwrap(addTicket(s3.sprint, s3Ticket));
  const s3Planned = unwrap(planSprint(s3Draft, now));
  const task = unwrap(
    createTask({
      name: 'Make hello.py print "Hello, world!"',
      description: 'Replace the placeholder greeting with the canonical hello-world output.',
      order: 1,
      ticketId: s3Ticket.id,
      repositoryId: repo.id,
      steps: [
        'Open hello.py.',
        'Replace the print statement so it outputs exactly: Hello, world!',
        'Confirm `python3 hello.py` exits 0.',
      ],
      verificationCriteria: [
        {
          id: 'C1',
          assertion: 'Running hello.py prints "Hello, world!" and exits 0',
          check: 'auto',
          command: 'python3 hello.py',
        },
      ],
    })
  );
  unwrap(await repos.sprintRepo.save(s3Planned));
  unwrap(await repos.executionRepo.save(s3.execution));
  unwrap(await repos.taskRepo.saveAll(s3Planned.id, [task]));
  return { name: s3Planned.name, state: 'planned (1 task queued) — run Implement' };
};

/**
 * Seed a fresh demo workspace under `input.homeDir`: storage roots, one git-initialised
 * "hello-python" repo, one project, and the three pre-flow sprints. Additive by design — callers
 * that want a clean reseed are responsible for wiping `homeDir` first (see `ralphctl demo`'s
 * marker-guarded wipe policy); this function only ever creates.
 */
export const seedDemoWorkspace = async (
  deps: SeedDemoWorkspaceDeps,
  input: SeedDemoWorkspaceInput
): Promise<Result<SeedDemoSummary, DomainError>> => {
  const { runCommand, writeFile } = deps;
  const { homeDir, token } = input;
  try {
    const repoDirStr = join(String(homeDir), 'demo-repos', `hello-python-${token}`);
    const repoDir = unwrap(AbsolutePath.parse(repoDirStr));

    const paths = unwrap(storagePathsFromRoot(homeDir));
    unwrap(await ensureStorageRoots(paths));

    await seedMockRepo(runCommand, repoDirStr);

    const repos: SeedRepos = {
      sprintRepo: createFsSprintRepository({ root: paths.dataRoot }),
      executionRepo: createFsSprintExecutionRepository({ root: paths.dataRoot }),
      taskRepo: createFsTaskRepository({ root: paths.dataRoot }),
    };
    const projectRepo = createFsProjectRepository({ root: paths.dataRoot });

    const now = IsoTimestamp.now();

    const repo = unwrap(createRepository({ path: repoDir, name: 'hello-python', verifyScript: 'python3 hello.py' }));
    const project = unwrap(
      createProject({
        displayName: `Hello Python (demo ${token})`,
        description: 'Throwaway sandbox project for exercising refine / plan / implement.',
        repositories: [repo],
      })
    );
    unwrap(await projectRepo.save(project));

    const sprints = [
      await seedRefineSprint(repos, project, token),
      await seedPlanSprint(repos, project, token),
      await seedImplementSprint(repos, project, repo, token, now),
    ];

    // Sandbox marker — written last so a run that fails partway never leaves a marker behind
    // that would make a broken sandbox look wipe-safe.
    const markerPath = unwrap(AbsolutePath.parse(join(String(homeDir), DEMO_MARKER_FILENAME)));
    unwrap(await writeFile(markerPath, `${String(now)}\n`));

    return Result.ok({ homeDir, repoDir, projectName: project.displayName, sprints });
  } catch (cause) {
    if (cause instanceof StorageError) return Result.error(cause);
    return Result.error(cause as DomainError);
  }
};
