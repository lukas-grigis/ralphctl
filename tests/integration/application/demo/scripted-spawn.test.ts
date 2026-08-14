/**
 * The scripted demo spawn, driven through the REAL claude headless adapter.
 *
 * Nothing here hand-rolls the prompt: the output-contract section comes from
 * `renderContractSectionFor`, the same renderer the generator / evaluator leaves use, so the
 * "pull the signals path out of the prompt" contract is fenced against a change to how the
 * harness embeds that path. The written file is read back through `validateSignalsFile` — the
 * same validator the leaves run — so a transcript that drifts from the leaf contract fails here.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { type IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import { FULL_AUTO, READ_ONLY } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import { createClaudeProvider } from '@src/integration/ai/providers/claude/headless.ts';
import { renderContractSectionFor } from '@src/integration/ai/contract/_engine/render-contract-section.ts';
import { validateSignalsFile } from '@src/integration/ai/contract/_engine/validate-signals-file.ts';
import { generatorOutputContract } from '@src/application/flows/implement/leaves/generator.contract.ts';
import { evaluatorOutputContract } from '@src/application/flows/implement/leaves/evaluator.contract.ts';
import { createDemoProviderSpawn, resolveSpawnTarget } from '@src/application/demo/scripted-spawn.ts';
import { DEMO_TARGET_FILE, demoTranscript } from '@src/application/demo/transcript.ts';
import { createCapturingBus } from '@tests/fixtures/capturing-event-bus.ts';

const FIXED_NOW = (): IsoTimestamp => '2026-08-14T10:00:00.000Z' as IsoTimestamp;

let root: string;

const abs = (p: string): AbsolutePath => {
  const parsed = AbsolutePath.parse(p);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};

/** `<root>/rounds/<N>/<role>/` — the exact layout `roundSignalsPath` produces. */
const roundDir = async (round: number, role: 'generator' | 'evaluator'): Promise<AbsolutePath> => {
  const dir = join(root, 'rounds', String(round), role);
  await fs.mkdir(dir, { recursive: true });
  return abs(dir);
};

const runScriptedSession = async (
  round: number,
  role: 'generator' | 'evaluator'
): Promise<{ readonly outputDir: AbsolutePath; readonly sessionId: string | undefined; readonly exitCode: number }> => {
  const outputDir = await roundDir(round, role);
  const contractSection =
    role === 'generator'
      ? renderContractSectionFor(generatorOutputContract, outputDir)
      : renderContractSectionFor(evaluatorOutputContract, outputDir);
  const cwd = abs(join(root, 'repo'));
  const provider = createClaudeProvider({
    spawn: createDemoProviderSpawn(demoTranscript(FIXED_NOW)),
    eventBus: createCapturingBus().bus,
    rateLimitRetries: 0,
  });
  const session: AiSession = {
    prompt: `Do the task.\n\n${contractSection}`,
    cwd,
    model: 'claude-opus-5',
    permissions: role === 'generator' ? FULL_AUTO : READ_ONLY,
    signalsFile: abs(join(String(outputDir), 'signals.json')),
    outputDir,
  };
  const out = await provider.generate(session);
  if (!out.ok) throw out.error;
  return { outputDir, sessionId: out.value.sessionId, exitCode: out.value.exitCode };
};

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'ralphctl-demo-spawn-'));
  await fs.mkdir(join(root, 'repo'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('createDemoProviderSpawn', () => {
  it('writes a contract-valid generator payload and the workspace file for round 1', async () => {
    const { outputDir, exitCode } = await runScriptedSession(1, 'generator');
    expect(exitCode).toBe(0);

    const validated = await validateSignalsFile(outputDir, generatorOutputContract);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.value.map((s) => s.type)).toContain('task-complete');

    // The generator really writes the file it claims to write — this is the diff the commit leaf
    // records and the file the verify gate reads.
    const written = await fs.readFile(join(root, 'repo', DEMO_TARGET_FILE), 'utf8');
    expect(written).toContain('Hello world');
    expect(written).not.toContain('Hello, world!');
  });

  it('fails the first evaluation with evidence and passes the second', async () => {
    const first = await runScriptedSession(1, 'evaluator');
    const firstSignals = await validateSignalsFile(first.outputDir, evaluatorOutputContract);
    expect(firstSignals.ok).toBe(true);
    if (!firstSignals.ok) return;
    const firstVerdict = firstSignals.value.find((s) => s.type === 'evaluation');
    expect(firstVerdict?.type === 'evaluation' && firstVerdict.status).toBe('failed');
    const failing = firstVerdict?.type === 'evaluation' ? firstVerdict.dimensions.filter((d) => !d.passed) : [];
    expect(failing).toHaveLength(1);
    expect(failing[0]?.executionEvidence ?? '').toContain('exit 1');

    const second = await runScriptedSession(2, 'evaluator');
    const secondSignals = await validateSignalsFile(second.outputDir, evaluatorOutputContract);
    expect(secondSignals.ok).toBe(true);
    if (!secondSignals.ok) return;
    const secondVerdict = secondSignals.value.find((s) => s.type === 'evaluation');
    expect(secondVerdict?.type === 'evaluation' && secondVerdict.status).toBe('passed');
  });

  it('writes the corrected file on the round-2 generator beat', async () => {
    await runScriptedSession(1, 'generator');
    await runScriptedSession(2, 'generator');
    const written = await fs.readFile(join(root, 'repo', DEMO_TARGET_FILE), 'utf8');
    expect(written).toContain('Hello, world!');
  });

  it('reports a session id per role so the next round resumes the same thread', async () => {
    const first = await runScriptedSession(1, 'generator');
    const second = await runScriptedSession(2, 'generator');
    expect(first.sessionId).toBeDefined();
    expect(second.sessionId).toBe(first.sessionId);
  });

  it('exits non-zero on a prompt whose output path is not scripted', async () => {
    const outputDir = abs(join(root, 'rounds', '1', 'reproduce'));
    await fs.mkdir(String(outputDir), { recursive: true });
    const provider = createClaudeProvider({
      spawn: createDemoProviderSpawn(demoTranscript(FIXED_NOW)),
      eventBus: createCapturingBus().bus,
      rateLimitRetries: 0,
    });
    const out = await provider.generate({
      prompt: renderContractSectionFor(generatorOutputContract, outputDir),
      cwd: abs(join(root, 'repo')),
      model: 'claude-opus-5',
      permissions: FULL_AUTO,
      signalsFile: abs(join(String(outputDir), 'signals.json')),
      outputDir,
    });
    expect(out.ok).toBe(false);
  });
});

describe('resolveSpawnTarget', () => {
  it('reads the role and round out of the rendered contract section', () => {
    const outputDir = abs(join(root, 'rounds', '7', 'evaluator'));
    const target = resolveSpawnTarget(renderContractSectionFor(evaluatorOutputContract, outputDir));
    expect(target).toEqual({
      signalsPath: join(String(outputDir), 'signals.json'),
      role: 'evaluator',
      round: 7,
    });
  });

  it('returns undefined when the prompt carries no signals path', () => {
    expect(resolveSpawnTarget('there is no output contract in this prompt')).toBeUndefined();
  });

  // Regression: the evaluate template says "Signal written to `<outputDir>/signals.json`" in prose.
  // A looser match locks onto that placeholder, reports a role of `<outputDir>`, and the whole
  // scripted run blocks on "the demo transcript does not script this output path".
  it('ignores the templates placeholder prose and takes the real round directory', () => {
    const outputDir = abs(join(root, 'rounds', '2', 'evaluator'));
    const prompt = [
      '- Signal written to `<outputDir>/signals.json` — no other files written.',
      '',
      renderContractSectionFor(evaluatorOutputContract, outputDir),
    ].join('\n');
    expect(resolveSpawnTarget(prompt)).toEqual({
      signalsPath: join(String(outputDir), 'signals.json'),
      role: 'evaluator',
      round: 2,
    });
  });
});
