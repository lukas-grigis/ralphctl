import { describe, expect, it } from 'vitest';
import { SkillFrontmatterSchema, SkillNameSchema } from '@src/integration/ai/skills/_engine/skill.ts';

describe('SkillNameSchema', () => {
  it('accepts kebab-case names', () => {
    expect(SkillNameSchema.safeParse('alignment').success).toBe(true);
    expect(SkillNameSchema.safeParse('abstraction-first').success).toBe(true);
    expect(SkillNameSchema.safeParse('a').success).toBe(true);
    expect(SkillNameSchema.safeParse('skill-1').success).toBe(true);
  });
  it('rejects PascalCase / camelCase / underscores', () => {
    expect(SkillNameSchema.safeParse('Alignment').success).toBe(false);
    expect(SkillNameSchema.safeParse('abstractionFirst').success).toBe(false);
    expect(SkillNameSchema.safeParse('abstraction_first').success).toBe(false);
    expect(SkillNameSchema.safeParse('').success).toBe(false);
  });
  it('rejects leading / trailing / consecutive hyphens', () => {
    expect(SkillNameSchema.safeParse('-alignment').success).toBe(false);
    expect(SkillNameSchema.safeParse('alignment-').success).toBe(false);
    expect(SkillNameSchema.safeParse('foo--bar').success).toBe(false);
  });
  it('rejects names longer than 64 chars', () => {
    expect(SkillNameSchema.safeParse('a'.repeat(64)).success).toBe(true);
    expect(SkillNameSchema.safeParse('a'.repeat(65)).success).toBe(false);
  });
});

describe('SkillFrontmatterSchema', () => {
  it('parses minimal well-formed frontmatter', () => {
    const result = SkillFrontmatterSchema.safeParse({
      name: 'alignment',
      description: 'Confirm scope before diving in.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('alignment');
      expect(result.data.license).toBeUndefined();
    }
  });
  it('parses the optional spec fields', () => {
    const result = SkillFrontmatterSchema.safeParse({
      name: 'pdf-processing',
      description: 'Extract PDF text, fill forms.',
      license: 'Apache-2.0',
      compatibility: 'Requires Python 3.14+',
      'allowed-tools': 'Bash(git:*) Read',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.license).toBe('Apache-2.0');
      expect(result.data.compatibility).toBe('Requires Python 3.14+');
      expect(result.data['allowed-tools']).toBe('Bash(git:*) Read');
    }
  });
  it('rejects missing name or description', () => {
    expect(SkillFrontmatterSchema.safeParse({ name: 'x' }).success).toBe(false);
    expect(SkillFrontmatterSchema.safeParse({ description: 'x' }).success).toBe(false);
    expect(SkillFrontmatterSchema.safeParse({}).success).toBe(false);
  });
  it('rejects names that violate the spec', () => {
    expect(SkillFrontmatterSchema.safeParse({ name: 'BadName', description: 'y' }).success).toBe(false);
    expect(SkillFrontmatterSchema.safeParse({ name: '-bad', description: 'y' }).success).toBe(false);
  });
  it('rejects descriptions longer than 1024 chars', () => {
    expect(SkillFrontmatterSchema.safeParse({ name: 'x', description: 'a'.repeat(1024) }).success).toBe(true);
    expect(SkillFrontmatterSchema.safeParse({ name: 'x', description: 'a'.repeat(1025) }).success).toBe(false);
  });
});
