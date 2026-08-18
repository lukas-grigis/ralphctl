import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CliHome, createCliHome, runCliCaptured } from '@tests/e2e/cli/_harness.ts';
import { RALPHCTL_DEBUG_TRACE_ENV } from '@src/application/bootstrap/wire.ts';

/**
 * The CLI's terminal error frame. `bootstrapCli`'s pre-flights (storage paths / roots / settings /
 * bundle integrity) throw plain `Error`s, and uncaught they reach Node's crash handler — which on
 * an installed package prints a source excerpt from the bundled `dist/cli-<hash>.mjs`, a full
 * commander stack and a `Node.js v<x>` footer. `doctor` is the command an operator runs BECAUSE
 * something is wrong, so it is the worst possible place for that output.
 */
describe('CLI top-level error handling', () => {
  let cli: CliHome;

  const writeSettings = async (body: string): Promise<void> => {
    await fs.writeFile(join(String(cli.paths.configRoot), 'settings.json'), body, 'utf8');
  };

  beforeEach(async () => {
    cli = await createCliHome();
    delete process.env[RALPHCTL_DEBUG_TRACE_ENV];
  });

  afterEach(async () => {
    delete process.env[RALPHCTL_DEBUG_TRACE_ENV];
    await cli.cleanup();
  });

  it('reports a malformed settings.json as one actionable line, not a stack trace', async () => {
    await writeSettings('not json at all');

    const result = await runCliCaptured(cli, ['doctor']);

    expect(result.exitCode).toBe(1);
    const lines = result.stderr.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^ralphctl: settings: /);
    expect(lines[0]).toContain('settings.json');
    // No stack: no `at <frame>` lines and no Node crash banner.
    expect(result.stderr).not.toMatch(/\n\s+at /);
    expect(result.stderr).not.toContain('Node.js v');
    // The repair is named, not just the fault.
    expect(result.stderr).toContain(RALPHCTL_DEBUG_TRACE_ENV);
  });

  it('renders a schema-invalid settings.json as compact field-level issues', async () => {
    await writeSettings(JSON.stringify({ schemaVersion: 1, ai: { provider: 12345 } }));

    const result = await runCliCaptured(cli, ['doctor']);

    expect(result.exitCode).toBe(1);
    const firstLine = result.stderr.split('\n')[0] ?? '';
    expect(firstLine).toContain('are invalid');
    // The old message inlined `ZodError.message` — a pretty-printed JSON dump of every issue.
    expect(firstLine).not.toContain('"code"');
    expect(firstLine).toContain('fix or delete settings.json');
  });

  it('keeps the full stack behind RALPHCTL_DEBUG_TRACE', async () => {
    await writeSettings('not json at all');
    process.env[RALPHCTL_DEBUG_TRACE_ENV] = '1';

    const result = await runCliCaptured(cli, ['doctor']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/^ralphctl: settings: /);
    expect(result.stderr).toMatch(/\n\s+at /);
  });
});
