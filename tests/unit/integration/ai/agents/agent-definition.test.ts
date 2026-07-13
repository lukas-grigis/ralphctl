import { describe, expect, it } from 'vitest';
import {
  AgentDefinitionFrontmatterSchema,
  AgentDefinitionNameSchema,
} from '@src/integration/ai/agents/_engine/agent-definition.ts';

describe('AgentDefinitionNameSchema', () => {
  it('accepts kebab-case names', () => {
    expect(AgentDefinitionNameSchema.safeParse('implementer').success).toBe(true);
    expect(AgentDefinitionNameSchema.safeParse('code-reviewer').success).toBe(true);
    expect(AgentDefinitionNameSchema.safeParse('a').success).toBe(true);
    expect(AgentDefinitionNameSchema.safeParse('agent-1').success).toBe(true);
  });
  it('rejects PascalCase / camelCase / underscores', () => {
    expect(AgentDefinitionNameSchema.safeParse('Implementer').success).toBe(false);
    expect(AgentDefinitionNameSchema.safeParse('codeReviewer').success).toBe(false);
    expect(AgentDefinitionNameSchema.safeParse('code_reviewer').success).toBe(false);
    expect(AgentDefinitionNameSchema.safeParse('').success).toBe(false);
  });
  it('rejects leading / trailing / consecutive hyphens', () => {
    expect(AgentDefinitionNameSchema.safeParse('-implementer').success).toBe(false);
    expect(AgentDefinitionNameSchema.safeParse('implementer-').success).toBe(false);
    expect(AgentDefinitionNameSchema.safeParse('foo--bar').success).toBe(false);
  });
  it('rejects names longer than 64 chars', () => {
    expect(AgentDefinitionNameSchema.safeParse('a'.repeat(64)).success).toBe(true);
    expect(AgentDefinitionNameSchema.safeParse('a'.repeat(65)).success).toBe(false);
  });
});

describe('AgentDefinitionFrontmatterSchema', () => {
  it('parses minimal well-formed frontmatter', () => {
    const result = AgentDefinitionFrontmatterSchema.safeParse({
      name: 'implementer',
      description: 'Writes features, fixes bugs, adds tests.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('implementer');
      expect(result.data.model).toBeUndefined();
      expect(result.data.effort).toBeUndefined();
    }
  });
  it('parses the optional model / effort fields', () => {
    const result = AgentDefinitionFrontmatterSchema.safeParse({
      name: 'implementer',
      description: 'Writes features, fixes bugs, adds tests.',
      model: 'claude-sonnet-5',
      effort: 'high',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.model).toBe('claude-sonnet-5');
      expect(result.data.effort).toBe('high');
    }
  });
  it('rejects missing name or description', () => {
    expect(AgentDefinitionFrontmatterSchema.safeParse({ name: 'x' }).success).toBe(false);
    expect(AgentDefinitionFrontmatterSchema.safeParse({ description: 'x' }).success).toBe(false);
    expect(AgentDefinitionFrontmatterSchema.safeParse({}).success).toBe(false);
  });
  it('rejects names that violate the naming convention', () => {
    expect(AgentDefinitionFrontmatterSchema.safeParse({ name: 'BadName', description: 'y' }).success).toBe(false);
    expect(AgentDefinitionFrontmatterSchema.safeParse({ name: '-bad', description: 'y' }).success).toBe(false);
  });
  it('rejects descriptions longer than 1024 chars', () => {
    expect(AgentDefinitionFrontmatterSchema.safeParse({ name: 'x', description: 'a'.repeat(1024) }).success).toBe(true);
    expect(AgentDefinitionFrontmatterSchema.safeParse({ name: 'x', description: 'a'.repeat(1025) }).success).toBe(
      false
    );
  });
});
