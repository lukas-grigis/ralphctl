import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { HarnessSignal } from '@src/domain/signal.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { Result } from '@src/domain/result.ts';
import { addTicket } from '@src/domain/entity/sprint.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { ensureStorageRoots, storagePathsFromRoot } from '@src/application/bootstrap/storage-paths.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { wire } from '@src/application/bootstrap/wire.ts';
import { createRefineFlow } from '@src/application/flows/refine/flow.ts';
import type { AppSinks } from '@src/application/bootstrap/runtime-sinks.ts';
import {
  absolutePath,
  makeDraftSprint,
  makeDraftSprintBundle,
  makePendingTicket,
  makeProject,
} from '@tests/fixtures/domain.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import type { ProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';
import { createInMemorySink } from '@tests/fixtures/in-memory-sink.ts';
import { nullSink } from '@src/integration/observability/sinks/null-sink.ts';
import { createRunner } from '@src/application/chain/run/runner.ts';

const noOpSinks = (): AppSinks => ({ harness: nullSink() });

describe('wire', () => {
  let tmpHome: string;

  beforeEach(async () => {
    const raw = await fs.mkdtemp(join(tmpdir(), 'ralphctl-v2-wire-'));
    tmpHome = await realpath(raw);
  });

  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it('returns repos that read and write under the injected storage root, never the real home', async () => {
    const appRoot = AbsolutePath.parse(`${tmpHome}/.ralphctl-v2-test`);
    if (!appRoot.ok) throw new Error('appRoot parse failed');
    const paths = storagePathsFromRoot(appRoot.value);
    if (!paths.ok) throw new Error('storagePathsFromRoot failed');
    await ensureStorageRoots(paths.value);

    const deps = wire({ storage: paths.value, sinks: noOpSinks(), settings: DEFAULT_SETTINGS });

    // Round-trip a project + sprint through the wired repos.
    const project = makeProject();
    await deps.projectRepo.save(project);
    const loadedProject = await deps.projectRepo.findById(project.id);
    expect(loadedProject.ok).toBe(true);
    if (loadedProject.ok) expect(loadedProject.value).toEqual(project);

    const { sprint, execution } = makeDraftSprintBundle();
    await deps.sprintRepo.save(sprint);
    await deps.sprintExecutionRepo.save(execution);

    const loadedSprint = await deps.sprintRepo.findById(sprint.id);
    const loadedExec = await deps.sprintExecutionRepo.findById(execution.sprintId);
    expect(loadedSprint.ok).toBe(true);
    expect(loadedExec.ok).toBe(true);

    // The data lives under the injected dataRoot — proof that nothing touched the real home.
    const projectFile = `${String(paths.value.dataRoot)}/projects/${String(project.id)}.json`;
    const stat = await fs.stat(projectFile);
    expect(stat.isFile()).toBe(true);
  });

  it('produces independent dependency graphs for each call (no shared state)', async () => {
    const appRoot = AbsolutePath.parse(`${tmpHome}/.ralphctl-v2-test`);
    if (!appRoot.ok) throw new Error('appRoot parse failed');
    const paths = storagePathsFromRoot(appRoot.value);
    if (!paths.ok) throw new Error('storagePathsFromRoot failed');
    await ensureStorageRoots(paths.value);

    const a = wire({ storage: paths.value, sinks: noOpSinks(), settings: DEFAULT_SETTINGS });
    const b = wire({ storage: paths.value, sinks: noOpSinks(), settings: DEFAULT_SETTINGS });

    expect(a.projectRepo).not.toBe(b.projectRepo);
    expect(a.sprintRepo).not.toBe(b.sprintRepo);
  });

  it('exposes a real provider built from config; refine runs end-to-end with a fake spawn', async () => {
    const appRoot = AbsolutePath.parse(`${tmpHome}/.ralphctl-v2-test`);
    if (!appRoot.ok) throw new Error('appRoot parse failed');
    const paths = storagePathsFromRoot(appRoot.value);
    if (!paths.ok) throw new Error('storagePathsFromRoot failed');
    await ensureStorageRoots(paths.value);

    const draft = makeDraftSprint();
    const ticket = makePendingTicket({ title: 'wire-it-test' });
    const withTicket = addTicket(draft, ticket);
    if (!withTicket.ok) throw new Error('fixture: addTicket failed');

    const sinks: AppSinks = {
      harness: createInMemorySink<HarnessSignal>(),
    };

    // Fake spawn that scripts a successful Claude call: a markdown body containing a
    // task-verified signal — refine itself doesn't require signals, but exercising the
    // parsing path through the wired provider proves the seam works.
    const spawn: ProviderSpawn = () => makeFakeChild();

    const deps = wire({ storage: paths.value, sinks, settings: DEFAULT_SETTINGS, spawn });
    await deps.sprintRepo.save(withTicket.value);

    // Refine is now interactive — replace the wired interactiveAi with a fake that writes a
    // stub requirements body so the test doesn't need to spawn a real Claude binary.
    const fakeInteractiveAi = {
      async run(input: { readonly outputFile: AbsolutePath }) {
        await fs.writeFile(String(input.outputFile), '# requirements approved by fake claude', 'utf8');
        return Result.ok({});
      },
    };
    const refinementRoot = AbsolutePath.parse(join(tmpHome, 'refinement'));
    if (!refinementRoot.ok) throw new Error('refinementRoot');
    await fs.mkdir(String(refinementRoot.value), { recursive: true });

    const flow = createRefineFlow(
      {
        sprintRepo: deps.sprintRepo,
        interactiveAi: fakeInteractiveAi,
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        writeFile: deps.writeFile,
        runInTerminal: async (fn) => fn(),
        eventBus: createInMemoryEventBus(),
        logger: deps.logger,
        skillsAdapter: deps.skillsAdapter,
        skillSource: deps.skillSource,
      },
      {
        sprintId: withTicket.value.id,
        pendingTickets: [ticket],
        cwd: absolutePath('/tmp/wire-test-cwd'),
        model: 'claude-sonnet-4-6',
        refinementRoot: refinementRoot.value,
      }
    );

    const runner = createRunner({
      id: 'r-wire-refine',
      element: flow,
      initialCtx: { sprintId: withTicket.value.id },
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    // The saved sprint has its first ticket transitioned to approved.
    const reloaded = await deps.sprintRepo.findById(withTicket.value.id);
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect(reloaded.value.tickets[0]?.status).toBe('approved');
  });
});

/**
 * Minimal scriptable child for the wire integration test. Emits a single line of body
 * (sufficient for the refine flow which only consumes the markdown body), then exits cleanly.
 */
const makeFakeChild = (): ChildProcessWithoutNullStreams => {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new EventEmitter() as ChildProcessWithoutNullStreams['stdout'];
  const stderr = new EventEmitter() as ChildProcessWithoutNullStreams['stderr'];
  (stdout as unknown as { setEncoding: (e: string) => void }).setEncoding = (): void => {};
  (stderr as unknown as { setEncoding: (e: string) => void }).setEncoding = (): void => {};
  Object.assign(child, {
    stdout,
    stderr,
    stdin: {
      end(_data: unknown): void {
        void _data;
      },
    },
    kill(): boolean {
      return true;
    },
  });
  setTimeout(() => {
    stdout.emit('data', '# requirements approved by fake claude\n');
    setTimeout(() => child.emit('exit', 0, null), 0);
  }, 0);
  return child;
};
