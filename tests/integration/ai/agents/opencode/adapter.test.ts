import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { AgentDefinition } from '@src/integration/ai/agents/_engine/agent-definition.ts';
import { createOpencodeAgentDefinitionAdapter } from '@src/integration/ai/agents/opencode/adapter.ts';

const makeSession = async (): Promise<AbsolutePath> => {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-agents-'));
  const parsed = AbsolutePath.parse(dir);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
};

const definition = (overrides: Partial<AgentDefinition> = {}): AgentDefinition => ({
  name: 'implementer',
  description: 'Writes features, fixes bugs, adds tests.',
  content: 'You are an implementer.\n',
  ...overrides,
});

describe('createOpencodeAgentDefinitionAdapter — golden render', () => {
  it('writes the definition to <sessionDir>/.opencode/agents/ralphctl-<name>.md as frontmatter + body', async () => {
    const session = await makeSession();
    const adapter = createOpencodeAgentDefinitionAdapter();

    const result = await adapter.install(session, [definition({ model: 'opencode/big-pickle' })]);
    expect(result.ok).toBe(true);

    const written = await readFile(join(String(session), '.opencode/agents/ralphctl-implementer.md'), 'utf-8');
    expect(written).toBe(
      [
        '---',
        'description: "Writes features, fixes bugs, adds tests."',
        'mode: subagent',
        'model: "opencode/big-pickle"',
        '---',
        '',
        'You are an implementer.',
        '',
      ].join('\n')
    );
  });

  it('emits no `name:` frontmatter key — OpenCode derives the name from the filename', async () => {
    const session = await makeSession();
    const adapter = createOpencodeAgentDefinitionAdapter();

    await adapter.install(session, [definition()]);

    const written = await readFile(join(String(session), '.opencode/agents/ralphctl-implementer.md'), 'utf-8');
    expect(written).not.toMatch(/^name:/m);
  });

  it('drops `effort` — OpenCode spells it `--variant` at invocation time, not per-agent', async () => {
    const session = await makeSession();
    const adapter = createOpencodeAgentDefinitionAdapter();

    await adapter.install(session, [definition({ effort: 'high' })]);

    const written = await readFile(join(String(session), '.opencode/agents/ralphctl-implementer.md'), 'utf-8');
    expect(written).not.toContain('effort');
  });

  it('omits the optional `model:` key when the definition carries no model', async () => {
    const session = await makeSession();
    const adapter = createOpencodeAgentDefinitionAdapter();

    await adapter.install(session, [definition()]);

    const written = await readFile(join(String(session), '.opencode/agents/ralphctl-implementer.md'), 'utf-8');
    expect(written).not.toContain('model:');
  });

  it('describeConvention mentions .opencode/agents/', () => {
    const adapter = createOpencodeAgentDefinitionAdapter();
    expect(adapter.describeConvention()).toContain('.opencode/agents/');
  });

  it('does not double-prefix a name that already carries the ralphctl- prefix', async () => {
    const session = await makeSession();
    const adapter = createOpencodeAgentDefinitionAdapter();

    const result = await adapter.install(session, [definition({ name: 'ralphctl-evaluator' })]);
    expect(result.ok).toBe(true);

    const written = await readFile(join(String(session), '.opencode/agents/ralphctl-evaluator.md'), 'utf-8');
    expect(written).toContain('mode: subagent');
  });
});
