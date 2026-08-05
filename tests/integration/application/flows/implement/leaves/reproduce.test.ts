import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { HeadlessAiProvider, ProviderOutput } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { ShellScriptRunner, ShellScriptResult } from '@src/integration/io/shell-script-runner.ts';
import { writeJsonAtomic } from '@src/integration/io/fs.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import {
  buildEvaluatorReproductionSection,
  clearReproductionArtifactLeaf,
  isDefectShapedTask,
  readReproductionSection,
  renderReproductionBody,
  REPRODUCTION_TAMPER_NOTE,
  reproduceLeaf,
  reproductionTestTampered,
  type ReproduceLeafDeps,
  type ReproduceLeafOpts,
  type ReproductionArtifact,
} from '@src/application/flows/implement/leaves/reproduce.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { absolutePath, makeTodoTask } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';

const TS = '2026-05-22T10:00:00.000Z' as IsoTimestamp;

/**
 * Integration tests for `reproduce.ts` — the guarded, once-per-task headless AI session that
 * runs before the gen-eval loop for defect-shaped tasks. Mirrors the fake-provider pattern in
 * `tests/integration/application/flows/detect-scripts/leaves/detect-scripts-contract.test.ts`.
 */

type EmitPayload =
  | { readonly kind: 'signals'; readonly signals: readonly HarnessSignal[] }
  | { readonly kind: 'raw'; readonly body: string }
  | { readonly kind: 'omit' }
  | { readonly kind: 'spawn-error'; readonly error: DomainError }
  | { readonly kind: 'abort' };

const fakeProvider = (payload: EmitPayload): HeadlessAiProvider => ({
  async generate(session: AiSession): Promise<Result<ProviderOutput, DomainError>> {
    if (payload.kind === 'spawn-error') return Result.error(payload.error);
    if (payload.kind === 'abort')
      throw new AbortError({ elementName: 'fake-reproduce-provider', reason: 'abort in test' });
    if (payload.kind === 'signals') {
      const wrote = await writeJsonAtomic(String(session.signalsFile), { schemaVersion: 1, signals: payload.signals });
      if (!wrote.ok) return Result.error(wrote.error);
    } else if (payload.kind === 'raw') {
      await fs.writeFile(String(session.signalsFile), payload.body, 'utf8');
    }
    // `omit` → never touch signalsFile → `validateSignalsFile` returns InvalidStateError.
    return Result.ok({ signalsFile: session.signalsFile, exitCode: 0 });
  },
});

type ShellResponder = (
  cwd: AbsolutePath,
  script: string
) => Promise<Result<ShellScriptResult, StorageError | AbortError>>;

const fakeShellRunner = (
  respond: ShellResponder,
  calls: Array<{ readonly cwd: string; readonly script: string }> = []
): ShellScriptRunner => ({
  async run(cwd, script) {
    calls.push({ cwd: String(cwd), script });
    return respond(cwd, script);
  },
});

const passResult = (output = ''): Result<ShellScriptResult, StorageError | AbortError> =>
  Result.ok({ passed: true, exitCode: 0, output, durationMs: 0 });

const failResult = (output: string): Result<ShellScriptResult, StorageError | AbortError> =>
  Result.ok({ passed: false, exitCode: 1, output, durationMs: 0 });

const reproductionSignal = (overrides: Partial<Record<string, unknown>> = {}): HarnessSignal =>
  ({
    type: 'reproduction',
    testPath: 'tests/unit/foo.test.ts',
    runCommand: 'npx vitest run tests/unit/foo.test.ts',
    observedFailure: 'expected 200, got 404',
    relevantTests: [],
    timestamp: TS,
    ...overrides,
  }) as unknown as HarnessSignal;

describe('reproduceLeaf — guarded reproduction-first leaf', () => {
  let root: Awaited<ReturnType<typeof makeTmpRoot>>;
  let cwd: AbsolutePath;
  let workspaceRoot: AbsolutePath;

  beforeEach(async () => {
    root = await makeTmpRoot();
    cwd = absolutePath(join(String(root.root), 'repo'));
    await fs.mkdir(String(cwd), { recursive: true });
    workspaceRoot = absolutePath(join(String(root.root), 'sprint', 'implement', 'task-1'));
    await fs.mkdir(String(workspaceRoot), { recursive: true });
  });

  afterEach(async () => {
    await root.cleanup();
  });

  const writeTestFile = async (relPath: string, content: string): Promise<void> => {
    const full = join(String(cwd), relPath);
    await fs.mkdir(join(full, '..'), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  };

  const buildDeps = (
    provider: HeadlessAiProvider,
    shellScriptRunner: ShellScriptRunner,
    published: HarnessSignal[] = []
  ): ReproduceLeafDeps => ({
    provider,
    templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
    publishSignal: (signal) => {
      published.push(signal);
    },
    shellScriptRunner,
    logger: noopLogger,
  });

  const buildOpts = (): ReproduceLeafOpts => ({
    cwd,
    progressFile: absolutePath(join(String(root.root), 'sprint', 'progress.md')),
    model: 'claude-sonnet-4-6',
  });

  const buildCtx = (task: ReturnType<typeof makeTodoTask>): ImplementCtx =>
    ({
      tasks: [task],
      taskWorkspaceRoot: workspaceRoot,
    }) as unknown as ImplementCtx;

  // ── 1. Happy path ────────────────────────────────────────────────────────────

  it('ok: valid reproduction + a failing re-run → validated artifact lands on ctx.reproductionArtifact', async () => {
    const task = makeTodoTask({ name: 'fix the null pointer' });
    await writeTestFile('tests/unit/foo.test.ts', 'describe/it stub content');
    const published: HarnessSignal[] = [];
    const provider = fakeProvider({ kind: 'signals', signals: [reproductionSignal()] });
    const shellCalls: Array<{ readonly cwd: string; readonly script: string }> = [];
    const shellScriptRunner = fakeShellRunner(
      async () => failResult('AssertionError: expected 200 to equal 404'),
      shellCalls
    );

    const leaf = reproduceLeaf(buildDeps(provider, shellScriptRunner, published), buildOpts(), task.id);
    const result = await leaf.execute(buildCtx(task));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const artifact = result.value.ctx.reproductionArtifact;
    expect(artifact).toBeDefined();
    expect(artifact?.testPath).toBe('tests/unit/foo.test.ts');
    expect(artifact?.runCommand).toBe('npx vitest run tests/unit/foo.test.ts');
    // observedFailure comes from the HARNESS's own re-run, not the AI's self-report.
    expect(artifact?.observedFailure).toBe('AssertionError: expected 200 to equal 404');
    expect(artifact?.checksum).toBe(createHash('sha256').update('describe/it stub content', 'utf-8').digest('hex'));
    // The harness re-ran the claimed command exactly once, against the repo cwd.
    expect(shellCalls).toHaveLength(1);
    expect(shellCalls[0]?.cwd).toBe(String(cwd));
    expect(shellCalls[0]?.script).toBe('npx vitest run tests/unit/foo.test.ts');
    // The validated signal is published onto the harness-signal channel.
    expect(published.map((s) => s.type)).toEqual(['reproduction']);
  });

  it('ok: relevantTests + note ride through unmodified', async () => {
    const task = makeTodoTask({ name: 'fix the crash' });
    await writeTestFile('tests/unit/foo.test.ts', 'x');
    const provider = fakeProvider({
      kind: 'signals',
      signals: [
        reproductionSignal({ relevantTests: ['tests/unit/bar.test.ts'] }),
        { type: 'note', text: 'chose the existing file', timestamp: TS } as unknown as HarnessSignal,
      ],
    });
    const shellScriptRunner = fakeShellRunner(async () => failResult('boom'));
    const leaf = reproduceLeaf(buildDeps(provider, shellScriptRunner), buildOpts(), task.id);

    const result = await leaf.execute(buildCtx(task));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.reproductionArtifact?.relevantTests).toEqual(['tests/unit/bar.test.ts']);
  });

  // ── 2. Failure tolerance — never blocks the task ────────────────────────────

  it('degrade: provider spawn error (non-fatal) → ctx unchanged, no artifact, no error', async () => {
    const task = makeTodoTask({ name: 'fix the null pointer' });
    const provider = fakeProvider({
      kind: 'spawn-error',
      error: new InvalidStateError({
        entity: 'provider',
        currentState: 'broken',
        attemptedAction: 'reproduce',
        message: 'simulated spawn failure',
      }),
    });
    const shellScriptRunner = fakeShellRunner(async () => passResult());
    const leaf = reproduceLeaf(buildDeps(provider, shellScriptRunner), buildOpts(), task.id);

    const result = await leaf.execute(buildCtx(task));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.reproductionArtifact).toBeUndefined();
  });

  it('degrade: signals.json missing (provider wrote nothing) → no artifact, no error', async () => {
    const task = makeTodoTask({ name: 'fix the null pointer' });
    const provider = fakeProvider({ kind: 'omit' });
    const shellScriptRunner = fakeShellRunner(async () => passResult());
    const leaf = reproduceLeaf(buildDeps(provider, shellScriptRunner), buildOpts(), task.id);

    const result = await leaf.execute(buildCtx(task));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.reproductionArtifact).toBeUndefined();
  });

  it('degrade: signals.json fails schema (missing testPath) → no artifact, no error', async () => {
    const task = makeTodoTask({ name: 'fix the null pointer' });
    const malformed = reproductionSignal() as unknown as Record<string, unknown>;
    delete malformed.testPath;
    const provider = fakeProvider({ kind: 'signals', signals: [malformed as unknown as HarnessSignal] });
    const shellScriptRunner = fakeShellRunner(async () => passResult());
    const leaf = reproduceLeaf(buildDeps(provider, shellScriptRunner), buildOpts(), task.id);

    const result = await leaf.execute(buildCtx(task));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.reproductionArtifact).toBeUndefined();
  });

  it('degrade: claimed command PASSES on the harness re-run → discarded, no artifact (a passing reproduction proves nothing)', async () => {
    const task = makeTodoTask({ name: 'fix the null pointer' });
    await writeTestFile('tests/unit/foo.test.ts', 'x');
    const provider = fakeProvider({ kind: 'signals', signals: [reproductionSignal()] });
    const shellScriptRunner = fakeShellRunner(async () => passResult('all green'));
    const leaf = reproduceLeaf(buildDeps(provider, shellScriptRunner), buildOpts(), task.id);

    const result = await leaf.execute(buildCtx(task));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.reproductionArtifact).toBeUndefined();
  });

  it('degrade: harness re-run spawn fails (non-fatal StorageError) → no artifact, no error', async () => {
    const task = makeTodoTask({ name: 'fix the null pointer' });
    await writeTestFile('tests/unit/foo.test.ts', 'x');
    const provider = fakeProvider({ kind: 'signals', signals: [reproductionSignal()] });
    const shellScriptRunner = fakeShellRunner(async () =>
      Result.error(new StorageError({ subCode: 'io', message: 'shell missing' }))
    );
    const leaf = reproduceLeaf(buildDeps(provider, shellScriptRunner), buildOpts(), task.id);

    const result = await leaf.execute(buildCtx(task));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.reproductionArtifact).toBeUndefined();
  });

  it('degrade: claimed test file is missing from disk (unreadable) → no artifact, no error', async () => {
    const task = makeTodoTask({ name: 'fix the null pointer' });
    // Deliberately do NOT write the claimed test file.
    const provider = fakeProvider({ kind: 'signals', signals: [reproductionSignal()] });
    const shellScriptRunner = fakeShellRunner(async () => failResult('boom'));
    const leaf = reproduceLeaf(buildDeps(provider, shellScriptRunner), buildOpts(), task.id);

    const result = await leaf.execute(buildCtx(task));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.reproductionArtifact).toBeUndefined();
  });

  // ── 3. Fatal errors propagate transparently ─────────────────────────────────

  it('fatal: AbortError from the provider spawn propagates (does not degrade)', async () => {
    const task = makeTodoTask({ name: 'fix the null pointer' });
    const provider = fakeProvider({ kind: 'abort' });
    const shellScriptRunner = fakeShellRunner(async () => passResult());
    const leaf = reproduceLeaf(buildDeps(provider, shellScriptRunner), buildOpts(), task.id);

    const result = await leaf.execute(buildCtx(task));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(AbortError);
  });

  it('fatal: AbortError from the harness re-run propagates (does not degrade to a discard)', async () => {
    const task = makeTodoTask({ name: 'fix the null pointer' });
    await writeTestFile('tests/unit/foo.test.ts', 'x');
    const provider = fakeProvider({ kind: 'signals', signals: [reproductionSignal()] });
    const shellScriptRunner = fakeShellRunner(async () =>
      Result.error(new AbortError({ elementName: 'shell-script-runner', reason: 'aborted' }))
    );
    const leaf = reproduceLeaf(buildDeps(provider, shellScriptRunner), buildOpts(), task.id);

    const result = await leaf.execute(buildCtx(task));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(AbortError);
  });

  // ── 4. Ctx-shape preconditions ───────────────────────────────────────────────

  it('throws InvalidStateError when the task is missing from ctx.tasks', async () => {
    const task = makeTodoTask({ name: 'fix the null pointer' });
    const provider = fakeProvider({ kind: 'signals', signals: [reproductionSignal()] });
    const shellScriptRunner = fakeShellRunner(async () => passResult());
    const leaf = reproduceLeaf(buildDeps(provider, shellScriptRunner), buildOpts(), task.id);

    const result = await leaf.execute({ tasks: [], taskWorkspaceRoot: workspaceRoot } as unknown as ImplementCtx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(InvalidStateError);
  });

  it('throws InvalidStateError when ctx.taskWorkspaceRoot is undefined', async () => {
    const task = makeTodoTask({ name: 'fix the null pointer' });
    const provider = fakeProvider({ kind: 'signals', signals: [reproductionSignal()] });
    const shellScriptRunner = fakeShellRunner(async () => passResult());
    const leaf = reproduceLeaf(buildDeps(provider, shellScriptRunner), buildOpts(), task.id);

    const result = await leaf.execute({ tasks: [task] } as unknown as ImplementCtx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(InvalidStateError);
  });
});

describe('isDefectShapedTask — guard predicate', () => {
  it('true for a bugfix-shaped task name', () => {
    const task = makeTodoTask({ name: 'fix the null pointer crash' });
    const ctx = { tasks: [task] } as unknown as ImplementCtx;
    expect(isDefectShapedTask(ctx, task.id)).toBe(true);
  });

  it('false for a feature-shaped task name', () => {
    const task = makeTodoTask({ name: 'add a new widget' });
    const ctx = { tasks: [task] } as unknown as ImplementCtx;
    expect(isDefectShapedTask(ctx, task.id)).toBe(false);
  });

  it('false when the task is absent from ctx.tasks', () => {
    const task = makeTodoTask({ name: 'fix the null pointer' });
    const ctx = { tasks: [] } as unknown as ImplementCtx;
    expect(isDefectShapedTask(ctx, task.id)).toBe(false);
  });
});

describe('clearReproductionArtifactLeaf — unconditional per-task reset', () => {
  it('clears a stale artifact carried from a prior task', async () => {
    const task = makeTodoTask({ name: 'add a widget' });
    const stale: ReproductionArtifact = {
      testPath: 'tests/unit/foo.test.ts',
      runCommand: 'npx vitest run tests/unit/foo.test.ts',
      observedFailure: 'boom',
      relevantTests: [],
      checksum: 'deadbeef',
    };
    const ctx = { tasks: [task], reproductionArtifact: stale } as unknown as ImplementCtx;

    const result = await clearReproductionArtifactLeaf(task.id).execute(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.reproductionArtifact).toBeUndefined();
  });

  it('is a no-op on a ctx with no artifact set', async () => {
    const task = makeTodoTask({ name: 'add a widget' });
    const ctx = { tasks: [task] } as unknown as ImplementCtx;

    const result = await clearReproductionArtifactLeaf(task.id).execute(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.reproductionArtifact).toBeUndefined();
  });
});

describe('renderReproductionBody / readReproductionSection — pure renderers', () => {
  const artifact: ReproductionArtifact = {
    testPath: 'tests/unit/foo.test.ts',
    runCommand: 'npx vitest run tests/unit/foo.test.ts',
    observedFailure: 'expected 200, got 404',
    relevantTests: ['tests/unit/bar.test.ts'],
    checksum: 'deadbeef',
  };

  it('renders test path, run command, relevant tests, and the observed failure in a fenced block', () => {
    const body = renderReproductionBody(artifact);
    expect(body).toContain('tests/unit/foo.test.ts');
    expect(body).toContain('npx vitest run tests/unit/foo.test.ts');
    expect(body).toContain('tests/unit/bar.test.ts');
    expect(body).toContain('expected 200, got 404');
    expect(body).toContain('```');
  });

  it('falls back to "none found" when relevantTests is empty', () => {
    const body = renderReproductionBody({ ...artifact, relevantTests: [] });
    expect(body).toContain('none found');
  });

  it('readReproductionSection returns undefined when ctx has no artifact, defined otherwise', () => {
    expect(readReproductionSection({} as unknown as ImplementCtx)).toBeUndefined();
    const withArtifact = { reproductionArtifact: artifact } as unknown as ImplementCtx;
    expect(readReproductionSection(withArtifact)).toBe(renderReproductionBody(artifact));
  });
});

describe('reproductionTestTampered / buildEvaluatorReproductionSection — checksum wiring (minors)', () => {
  let root: Awaited<ReturnType<typeof makeTmpRoot>>;
  let cwd: AbsolutePath;

  beforeEach(async () => {
    root = await makeTmpRoot();
    cwd = absolutePath(join(String(root.root), 'repo'));
    await fs.mkdir(String(cwd), { recursive: true });
  });

  afterEach(async () => {
    await root.cleanup();
  });

  const writeTestFile = async (relPath: string, content: string): Promise<void> => {
    const full = join(String(cwd), relPath);
    await fs.mkdir(join(full, '..'), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  };

  const artifactFor = (content: string): ReproductionArtifact => ({
    testPath: 'tests/unit/foo.test.ts',
    runCommand: 'npx vitest run tests/unit/foo.test.ts',
    observedFailure: 'expected 200, got 404',
    relevantTests: [],
    checksum: createHash('sha256').update(content, 'utf-8').digest('hex'),
  });

  it('reproductionTestTampered: false when the file on disk still matches the recorded checksum', async () => {
    const content = 'describe/it stub content';
    await writeTestFile('tests/unit/foo.test.ts', content);
    const tampered = await reproductionTestTampered(cwd, artifactFor(content));
    expect(tampered).toBe(false);
  });

  it('reproductionTestTampered: true when the file was edited since validation (checksum mismatch)', async () => {
    const artifact = artifactFor('describe/it stub content');
    // Simulate a generator turn rewriting the reproduction test mid-loop.
    await writeTestFile('tests/unit/foo.test.ts', 'expect(true).toBe(true); // edited');
    const tampered = await reproductionTestTampered(cwd, artifact);
    expect(tampered).toBe(true);
  });

  it('reproductionTestTampered: true when the file is missing (at least as suspicious as an edit)', async () => {
    const artifact = artifactFor('describe/it stub content');
    // Deliberately never write the file.
    const tampered = await reproductionTestTampered(cwd, artifact);
    expect(tampered).toBe(true);
  });

  it('buildEvaluatorReproductionSection: matching checksum → plain body, no tamper note', async () => {
    const content = 'describe/it stub content';
    await writeTestFile('tests/unit/foo.test.ts', content);
    const artifact = artifactFor(content);
    const section = await buildEvaluatorReproductionSection(cwd, artifact);
    expect(section).toBe(renderReproductionBody(artifact));
    expect(section).not.toContain(REPRODUCTION_TAMPER_NOTE);
  });

  it('buildEvaluatorReproductionSection: mismatched checksum → body PLUS the bounded tamper note', async () => {
    const artifact = artifactFor('describe/it stub content');
    await writeTestFile('tests/unit/foo.test.ts', 'expect(true).toBe(true); // edited');
    const section = await buildEvaluatorReproductionSection(cwd, artifact);
    expect(section).toContain(renderReproductionBody(artifact));
    expect(section).toContain(REPRODUCTION_TAMPER_NOTE);
    expect(section).toContain('TAMPERING CHECK');
  });
});
