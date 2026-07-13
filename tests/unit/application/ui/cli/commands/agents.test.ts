import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CliHome, createCliHome, runCliCaptured } from '@tests/e2e/cli/_harness.ts';

describe('ralphctl agents list', () => {
  let cli: CliHome;

  beforeEach(async () => {
    cli = await createCliHome();
  });

  afterEach(async () => cli.cleanup());

  it('lists the vetted bundled set on a fresh install, unbound', async () => {
    const result = await runCliCaptured(cli, ['agents', 'list']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ralphctl-evaluator');
    expect(result.stdout).toContain('ralphctl-generator');
    expect(result.stdout).toContain('bundled');
    // Neither role is bound yet.
    expect(result.stdout).not.toContain('bound: evaluator');
    expect(result.stdout).not.toContain('bound: generator');
  });

  it('shows the bound role after `settings set ai.implement.agents.evaluator`', async () => {
    const setResult = await runCliCaptured(cli, [
      'settings',
      'set',
      'ai.implement.agents.evaluator',
      'ralphctl-evaluator',
    ]);
    expect(setResult.exitCode).toBe(0);

    const listResult = await runCliCaptured(cli, ['agents', 'list']);
    expect(listResult.exitCode).toBe(0);
    const evaluatorLine = listResult.stdout.split('\n').find((line) => line.startsWith('ralphctl-evaluator'));
    expect(evaluatorLine).toContain('bound: evaluator');
    const generatorLine = listResult.stdout.split('\n').find((line) => line.startsWith('ralphctl-generator'));
    expect(generatorLine).toContain('bound: -');
  });
});

describe('ralphctl settings set ai.implement.agents.<role> — binding + unsupported-target reporting', () => {
  let cli: CliHome;

  beforeEach(async () => {
    cli = await createCliHome();
  });

  afterEach(async () => cli.cleanup());

  it('binds a vetted definition to the evaluator role', async () => {
    const setResult = await runCliCaptured(cli, [
      'settings',
      'set',
      'ai.implement.agents.evaluator',
      'ralphctl-evaluator',
    ]);
    expect(setResult.exitCode).toBe(0);
    expect(setResult.stdout).toContain('ai.implement.agents.evaluator = ralphctl-evaluator');

    const showResult = await runCliCaptured(cli, ['settings', 'show']);
    expect(showResult.exitCode).toBe(0);
    const parsed = JSON.parse(showResult.stdout) as {
      readonly ai: { readonly implement: { readonly agents?: { readonly evaluator?: string } } };
    };
    expect(parsed.ai.implement.agents?.evaluator).toBe('ralphctl-evaluator');
  });

  it('reports (not silently accepts) a binding targeting an unsupported flow', async () => {
    const result = await runCliCaptured(cli, ['settings', 'set', 'ai.plan.agents.generator', 'ralphctl-generator']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not supported for agent-definition binding in this release');

    // Nothing was persisted under ai.plan (the flow row has no agents field at all).
    const showResult = await runCliCaptured(cli, ['settings', 'show']);
    const parsed = JSON.parse(showResult.stdout) as { readonly ai: { readonly plan: Record<string, unknown> } };
    expect(parsed.ai.plan['agents']).toBeUndefined();
  });

  it('reports (not silently accepts) a binding targeting an unsupported implement role', async () => {
    const result = await runCliCaptured(cli, ['settings', 'set', 'ai.implement.agents.reviewer', 'ralphctl-evaluator']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not supported for agent-definition binding in this release');

    const showResult = await runCliCaptured(cli, ['settings', 'show']);
    const parsed = JSON.parse(showResult.stdout) as {
      readonly ai: { readonly implement: { readonly agents?: Record<string, unknown> } };
    };
    expect(parsed.ai.implement.agents).toBeUndefined();
  });
});
