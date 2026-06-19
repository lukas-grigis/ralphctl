/**
 * `seed-mock.ts` — generate a ready-to-drive mock project so you can exercise the
 * refine / plan / implement flows without the manual setup ceremony every time.
 *
 * Repeatably executable: wipes and regenerates a sandbox `RALPHCTL_HOME` plus a throwaway
 * "hello world" Python git repo, seeds one project and three sprints — each parked in exactly
 * the state one flow expects — then (by default) launches the TUI pointed at the sandbox so you
 * can select a sprint and take off.
 *
 *   pnpm mock                            # sandbox home defaults to /tmp/ralphctl-mock
 *   RALPHCTL_HOME=/tmp/foo pnpm mock     # custom sandbox home
 *   RALPHCTL_MOCK_NO_LAUNCH=1 pnpm mock  # seed only — print the launch command, don't open the TUI
 *
 * Seeded sprints (one per pre-flow state):
 *   1. "ready to refine"    — draft sprint, 1 pending ticket               → run Refine
 *   2. "ready to plan"      — draft sprint, 1 approved ticket              → run Plan
 *   3. "ready to implement" — planned sprint, 1 approved ticket + 1 task   → run Implement
 *
 * This script imports the SAME domain factories and persistence repositories the app uses, so
 * the on-disk shape can never drift from the real codecs — no hand-rolled JSON.
 */

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Result } from '@src/domain/result.ts';
import { ensureStorageRoots, storagePathsFromRoot } from '@src/application/bootstrap/storage-paths.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

import { createProject } from '@src/domain/entity/project.ts';
import { createRepository } from '@src/domain/entity/repository.ts';
import { approveTicketRequirements, createTicket } from '@src/domain/entity/ticket.ts';
import { addTicket, createSprintWithExecution, planSprint } from '@src/domain/entity/sprint.ts';
import { createTask } from '@src/domain/entity/task-factory.ts';

import { createFsProjectRepository } from '@src/integration/persistence/project/repository.ts';
import { createFsSprintRepository } from '@src/integration/persistence/sprint/repository.ts';
import { createFsSprintExecutionRepository } from '@src/integration/persistence/sprint-execution/repository.ts';
import { createFsTaskRepository } from '@src/integration/persistence/task/repository.ts';

// ── Paths & uniqueness ───────────────────────────────────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/** Short per-run token — keeps project / sprint / repo names distinct across runs. */
const TOKEN = randomUUID().slice(0, 8);

/**
 * Sandbox app-root. When `RALPHCTL_HOME` is set we honour it and seed ADDITIVELY (the token
 * keeps every run's slugs collision-free), so an explicit home accumulates fresh mock projects
 * and is never wiped — only a home WE generated under the tmp dir gets blown away on rerun.
 */
const EXPLICIT_HOME = process.env.RALPHCTL_HOME;
const HOME_DIR = EXPLICIT_HOME ?? join(tmpdir(), `ralphctl-mock-${TOKEN}`);
/** Throwaway target repo the implement flow operates on — per-run unique, inside the sandbox. */
const REPO_DIR = join(HOME_DIR, 'mock-repos', `hello-python-${TOKEN}`);

// ── Tiny Result/throw helpers (mirrors tests/fixtures/domain.ts) ─────────────────
const unwrap = <T, E>(r: Result<T, E>): T => {
  if (!r.ok) {
    const err: unknown = r.error;
    throw new Error(err instanceof Error ? err.message : JSON.stringify(err));
  }
  return r.value as T;
};

const expectOk = async <T, E>(p: Promise<Result<T, E>>, what: string): Promise<T> => {
  const r = await p;
  if (!r.ok) {
    const err = r.error as { message?: string };
    throw new Error(`${what} failed: ${err?.message ?? String(r.error)}`);
  }
  return r.value as T;
};

const git = (...args: readonly string[]): void => {
  const res = spawnSync('git', args, { cwd: REPO_DIR, stdio: 'ignore' });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${String(res.status)})`);
  }
};

// ── Mock target repo ─────────────────────────────────────────────────────────────
const seedMockRepo = async (): Promise<void> => {
  await fs.mkdir(REPO_DIR, { recursive: true });
  await fs.writeFile(
    join(REPO_DIR, 'hello.py'),
    '# Placeholder greeting — the implement sprint changes this to print "Hello, world!".\nprint("hi from the mock project")\n'
  );
  await fs.writeFile(
    join(REPO_DIR, 'README.md'),
    '# hello-python (ralphctl mock)\n\nThrowaway project for exercising the refine / plan / implement flows.\n\nRun: `python3 hello.py`\n'
  );
  // Deterministic, throwaway identity — never a real ralphctl commit.
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'ralphctl mock');
  git('config', 'user.email', 'mock@ralphctl.local');
  git('add', '-A');
  git('commit', '-m', 'chore: scaffold hello-python mock');
};

// ── Seed ───────────────────────────────────────────────────────────────────────
const main = async (): Promise<void> => {
  const appRoot = unwrap(AbsolutePath.parse(HOME_DIR));

  // Repeatable: blow away the sandbox before regenerating — but ONLY a home we generated
  // ourselves under the tmp dir. An explicit RALPHCTL_HOME is seeded additively and never wiped,
  // so pointing this at a real-ish store can't destroy existing data.
  if (EXPLICIT_HOME === undefined) {
    await fs.rm(HOME_DIR, { recursive: true, force: true });
  }

  const paths = unwrap(storagePathsFromRoot(appRoot));
  await expectOk(ensureStorageRoots(paths), 'ensureStorageRoots');

  await seedMockRepo();

  const projectRepo = createFsProjectRepository({ root: paths.dataRoot });
  const sprintRepo = createFsSprintRepository({ root: paths.dataRoot });
  const executionRepo = createFsSprintExecutionRepository({ root: paths.dataRoot });
  const taskRepo = createFsTaskRepository({ root: paths.dataRoot });

  const now = IsoTimestamp.now();

  // ── Project + repository ──
  const repo = unwrap(
    createRepository({
      path: unwrap(AbsolutePath.parse(REPO_DIR)),
      name: 'hello-python',
      verifyScript: 'python3 hello.py',
    })
  );
  const project = unwrap(
    createProject({
      displayName: `Hello Python (mock ${TOKEN})`,
      description: 'Throwaway sandbox project for exercising refine / plan / implement.',
      repositories: [repo],
    })
  );
  await expectOk(projectRepo.save(project), 'save project');

  // ── Sprint 1 — ready to refine: draft + 1 pending ticket ──
  const s1 = unwrap(createSprintWithExecution({ name: `ready to refine · ${TOKEN}`, projectId: project.id }));
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
  await expectOk(sprintRepo.save(s1Draft), 'save sprint 1');
  await expectOk(executionRepo.save(s1.execution), 'save execution 1');

  // ── Sprint 2 — ready to plan: draft + 1 approved ticket ──
  const s2 = unwrap(createSprintWithExecution({ name: `ready to plan · ${TOKEN}`, projectId: project.id }));
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
  await expectOk(sprintRepo.save(s2Draft), 'save sprint 2');
  await expectOk(executionRepo.save(s2.execution), 'save execution 2');

  // ── Sprint 3 — ready to implement: planned + 1 approved ticket + 1 task ──
  const s3 = unwrap(createSprintWithExecution({ name: `ready to implement · ${TOKEN}`, projectId: project.id }));
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
  await expectOk(sprintRepo.save(s3Planned), 'save sprint 3');
  await expectOk(executionRepo.save(s3.execution), 'save execution 3');
  await expectOk(taskRepo.saveAll(s3Planned.id, [task]), 'save sprint 3 tasks');

  // ── Summary ──
  const line = '─'.repeat(60);
  process.stdout.write(
    [
      '',
      line,
      '  Mock project seeded ✓',
      line,
      `  RALPHCTL_HOME : ${HOME_DIR}${EXPLICIT_HOME === undefined ? ' (auto, wiped each run)' : ' (explicit, additive)'}`,
      `  target repo   : ${REPO_DIR}  (git-initialised, python3 hello.py)`,
      `  project       : ${project.displayName}`,
      '',
      `  Sprints (token ${TOKEN}):`,
      '    • "ready to refine …"     draft   → run Refine on its ticket',
      '    • "ready to plan …"       draft   → run Plan (ticket already approved)',
      '    • "ready to implement …"  planned → run Implement (1 task queued)',
      line,
      '',
    ].join('\n')
  );

  if (process.env.RALPHCTL_MOCK_NO_LAUNCH) {
    process.stdout.write(`Launch it with:\n\n  RALPHCTL_HOME=${HOME_DIR} pnpm dev\n\n`);
    return;
  }

  process.stdout.write('Launching the TUI against the sandbox…\n\n');
  const child = spawn('pnpm', ['dev'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, RALPHCTL_HOME: HOME_DIR },
  });
  child.on('exit', (code) => process.exit(code ?? 0));
};

await main();
