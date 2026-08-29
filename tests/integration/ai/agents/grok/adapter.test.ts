import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { AgentDefinition } from '@src/integration/ai/agents/_engine/agent-definition.ts';
import { createGrokAgentDefinitionAdapter } from '@src/integration/ai/agents/grok/adapter.ts';

const makeSession = async (): Promise<AbsolutePath> => {
  const dir = await mkdtemp(join(tmpdir(), 'grok-agents-'));
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

describe('createGrokAgentDefinitionAdapter — golden render', () => {
  it('writes the definition to <sessionDir>/.grok/agents/ralphctl-<name>.md', async () => {
    const session = await makeSession();
    const adapter = createGrokAgentDefinitionAdapter();

    const result = await adapter.install(session, [definition({ model: 'grok-4.6', effort: 'xhigh' })]);
    expect(result.ok).toBe(true);

    const written = await readFile(join(String(session), '.grok/agents/ralphctl-implementer.md'), 'utf-8');
    expect(written).toBe(
      [
        '---',
        'name: "implementer"',
        'description: "Writes features, fixes bugs, adds tests."',
        'model: "grok-4.6"',
        '---',
        '',
        'You are an implementer.',
        '',
      ].join('\n')
    );
  });

  it('drops `effort` — Grok ignores Claude-only keys and does not emit them', async () => {
    const session = await makeSession();
    const adapter = createGrokAgentDefinitionAdapter();

    await adapter.install(session, [definition({ effort: 'xhigh' })]);

    const written = await readFile(join(String(session), '.grok/agents/ralphctl-implementer.md'), 'utf-8');
    expect(written).not.toContain('effort');
  });

  it('omits the optional `model:` key when the definition carries no model', async () => {
    const session = await makeSession();
    const adapter = createGrokAgentDefinitionAdapter();

    await adapter.install(session, [definition()]);

    const written = await readFile(join(String(session), '.grok/agents/ralphctl-implementer.md'), 'utf-8');
    expect(written).not.toContain('model:');
  });

  it('describeConvention mentions .grok/agents/', () => {
    const adapter = createGrokAgentDefinitionAdapter();
    expect(adapter.describeConvention()).toContain('.grok/agents/');
  });

  it('does not double-prefix a name that already carries the ralphctl- prefix', async () => {
    const session = await makeSession();
    const adapter = createGrokAgentDefinitionAdapter();

    await adapter.install(session, [definition({ name: 'ralphctl-evaluator' })]);

    const written = await readFile(join(String(session), '.grok/agents/ralphctl-evaluator.md'), 'utf-8');
    expect(written).toContain('name: "ralphctl-evaluator"');
  });
});

describe('createGrokAgentDefinitionAdapter — YAML frontmatter escaping', () => {
  it('quotes and escapes a description containing a colon-space, a leading #, and a double-quote', async () => {
    const session = await makeSession();
    const adapter = createGrokAgentDefinitionAdapter();
    const tricky = 'Reviews diffs: focuses on security, flags "#unsafe" patterns';

    await adapter.install(session, [definition({ description: tricky })]);

    const written = await readFile(join(String(session), '.grok/agents/ralphctl-implementer.md'), 'utf-8');
    expect(written).toContain(`description: ${JSON.stringify(tricky)}`);
    expect(written).not.toContain(`description: ${tricky}`);
  });

  it('does not let an embedded newline in the description inject a second frontmatter line', async () => {
    const session = await makeSession();
    const adapter = createGrokAgentDefinitionAdapter();

    await adapter.install(session, [definition({ description: 'Line one\nname: injected' })]);

    const written = await readFile(join(String(session), '.grok/agents/ralphctl-implementer.md'), 'utf-8');
    const frontmatterLines = written.split('---')[1]?.split('\n').filter(Boolean) ?? [];
    expect(frontmatterLines).toHaveLength(2);
    expect(written).toContain('description: "Line one\\nname: injected"');
  });
});
