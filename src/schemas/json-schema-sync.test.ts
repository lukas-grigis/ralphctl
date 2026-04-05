/**
 * JSON Schema ↔ Zod Schema Sync Tests
 *
 * These tests verify that the hand-written JSON schemas in /schemas/ stay in sync
 * with the authoritative Zod schemas in src/schemas/index.ts.
 *
 * When you change a Zod schema, update the corresponding JSON schema and these tests.
 * Failures here mean the AI prompt schemas are out of sync with runtime validation.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AiProviderSchema,
  IdeateOutputSchema,
  ImportTaskSchema,
  ProjectSchema,
  RefinedRequirementSchema,
  SprintSchema,
  SprintStatusSchema,
  TaskSchema,
  TaskStatusSchema,
} from '@src/schemas/index.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

type JsonSchema = Record<string, unknown>;

function loadJsonSchema(filename: string): JsonSchema {
  const path = join(process.cwd(), 'schemas', filename);
  return JSON.parse(readFileSync(path, 'utf-8')) as JsonSchema;
}

function getItemSchema(schema: JsonSchema): JsonSchema {
  return schema['items'] as JsonSchema;
}

function getProperties(schema: JsonSchema): JsonSchema {
  const props = schema['properties'];
  return (props as JsonSchema | undefined) ?? {};
}

function getRequired(schema: JsonSchema): string[] {
  const req = schema['required'];
  return (req as string[] | undefined) ?? [];
}

function getEnum(schema: JsonSchema, ...path: string[]): unknown[] {
  let current: unknown = schema;
  for (const key of path) {
    current = (current as JsonSchema)[key];
  }
  return current as unknown[];
}

function expectStringArrayProperty(props: JsonSchema, name: string, options?: { defaultEmpty?: boolean }): void {
  const prop = props[name] as JsonSchema | undefined;
  expect(prop).toBeDefined();
  expect(prop?.['type']).toBe('array');
  expect((prop?.['items'] as JsonSchema | undefined)?.['type']).toBe('string');
  if (options?.defaultEmpty) {
    expect(prop?.['default']).toEqual([]);
  }
}

// ─── TaskStatus enum ─────────────────────────────────────────────────────────

describe('tasks.schema.json ↔ TaskSchema', () => {
  const jsonSchema = loadJsonSchema('tasks.schema.json');
  const itemSchema = getItemSchema(jsonSchema);
  const props = getProperties(itemSchema);

  it('TaskStatus enum values match', () => {
    const jsonEnum = getEnum(props, 'status', 'enum');
    expect(jsonEnum).toEqual([...TaskStatusSchema.options]);
  });

  it('required fields match', () => {
    const jsonRequired = getRequired(itemSchema).sort();
    // These are the fields Zod treats as required (no .optional(), no .default())
    const zodRequired = ['id', 'name', 'status', 'order', 'projectPath'].sort();
    expect(jsonRequired).toEqual(zodRequired);
  });

  it('optional/defaulted array properties stay in sync', () => {
    expectStringArrayProperty(props, 'steps', { defaultEmpty: true });
    expectStringArrayProperty(props, 'verificationCriteria', { defaultEmpty: true });
    expectStringArrayProperty(props, 'blockedBy', { defaultEmpty: true });
  });

  it('Zod schema accepts a valid task object', () => {
    const valid = {
      id: 'abc12345',
      name: 'Implement login',
      status: 'todo' as const,
      order: 1,
      projectPath: '/home/user/myapp',
      blockedBy: [],
      steps: [],
      verified: false,
    };
    expect(() => TaskSchema.parse(valid)).not.toThrow();
  });

  it('Zod schema rejects task missing required fields', () => {
    expect(() => TaskSchema.parse({ name: 'Missing id and order' })).toThrow();
  });
});

// ─── SprintStatus enum ───────────────────────────────────────────────────────

describe('sprint.schema.json ↔ SprintSchema', () => {
  const jsonSchema = loadJsonSchema('sprint.schema.json');
  const props = getProperties(jsonSchema);

  it('SprintStatus enum values match', () => {
    const jsonEnum = getEnum(props, 'status', 'enum');
    expect(jsonEnum).toEqual([...SprintStatusSchema.options]);
  });

  it('required fields match', () => {
    const jsonRequired = getRequired(jsonSchema).sort();
    const zodRequired = ['id', 'name', 'status', 'createdAt'].sort();
    expect(jsonRequired).toEqual(zodRequired);
  });

  it('sprint id pattern matches between schemas', () => {
    const idSchema = props['id'] as JsonSchema;
    const jsonPattern = idSchema['pattern'] as string;
    // Both should match the same format: YYYYMMDD-HHmmss-slug
    const validId = '20260101-120000-my-sprint';
    expect(validId).toMatch(new RegExp(jsonPattern));
    expect(() =>
      SprintSchema.parse({
        id: validId,
        name: 'test',
        status: 'draft',
        createdAt: new Date().toISOString(),
        activatedAt: null,
        closedAt: null,
        tickets: [],
      })
    ).not.toThrow();
  });

  it('Zod schema rejects invalid sprint id format', () => {
    expect(() =>
      SprintSchema.parse({
        id: 'invalid-format',
        name: 'test',
        status: 'draft',
        createdAt: new Date().toISOString(),
      })
    ).toThrow();
  });
});

// ─── Projects schema ─────────────────────────────────────────────────────────

describe('projects.schema.json ↔ ProjectSchema', () => {
  const jsonSchema = loadJsonSchema('projects.schema.json');
  const itemSchema = getItemSchema(jsonSchema);

  it('required fields match', () => {
    const jsonRequired = getRequired(itemSchema).sort();
    const zodRequired = ['name', 'displayName', 'repositories'].sort();
    expect(jsonRequired).toEqual(zodRequired);
  });

  it('repository required fields match', () => {
    const repoSchema = (getProperties(itemSchema)['repositories'] as JsonSchema)['items'] as JsonSchema;
    const jsonRequired = getRequired(repoSchema).sort();
    const zodRequired = ['name', 'path'].sort();
    expect(jsonRequired).toEqual(zodRequired);
  });

  it('Zod schema accepts a valid project', () => {
    const valid = {
      name: 'my-app',
      displayName: 'My App',
      repositories: [{ name: 'backend', path: '/home/user/backend' }],
    };
    expect(() => ProjectSchema.parse(valid)).not.toThrow();
  });

  it('Zod schema rejects project name that is not a slug', () => {
    expect(() =>
      ProjectSchema.parse({
        name: 'My App With Spaces',
        displayName: 'My App',
        repositories: [{ name: 'backend', path: '/home/user/backend' }],
      })
    ).toThrow();
  });
});

// ─── Task import schema ───────────────────────────────────────────────────────

describe('task-import.schema.json ↔ ImportTaskSchema', () => {
  const jsonSchema = loadJsonSchema('task-import.schema.json');
  const itemSchema = getItemSchema(jsonSchema);
  const props = getProperties(itemSchema);

  it('required fields match', () => {
    const jsonRequired = getRequired(itemSchema).sort();
    const zodRequired = ['name', 'projectPath'].sort();
    expect(jsonRequired).toEqual(zodRequired);
  });

  it('optional array properties stay in sync', () => {
    expectStringArrayProperty(props, 'steps');
    expectStringArrayProperty(props, 'verificationCriteria');
    expectStringArrayProperty(props, 'blockedBy');
  });

  it('Zod schema accepts a valid import task', () => {
    const valid = {
      name: 'Add authentication',
      projectPath: '/home/user/myapp',
    };
    expect(() => ImportTaskSchema.parse(valid)).not.toThrow();
  });

  it('Zod schema rejects import task missing projectPath', () => {
    expect(() => ImportTaskSchema.parse({ name: 'Missing projectPath' })).toThrow();
  });
});

// ─── Requirements output schema ───────────────────────────────────────────────

describe('requirements-output.schema.json ↔ RefinedRequirementSchema', () => {
  const jsonSchema = loadJsonSchema('requirements-output.schema.json');
  const itemSchema = getItemSchema(jsonSchema);

  it('required fields match', () => {
    const jsonRequired = getRequired(itemSchema).sort();
    const zodRequired = ['ref', 'requirements'].sort();
    expect(jsonRequired).toEqual(zodRequired);
  });

  it('Zod schema accepts a valid refined requirement', () => {
    const valid = {
      ref: 'TICKET-001',
      requirements: '## Requirements\n\nImplement user login.',
    };
    expect(() => RefinedRequirementSchema.parse(valid)).not.toThrow();
  });
});

// ─── Ideate output schema ─────────────────────────────────────────────────────

describe('ideate-output.schema.json ↔ IdeateOutputSchema', () => {
  const jsonSchema = loadJsonSchema('ideate-output.schema.json');

  it('required fields match', () => {
    const jsonRequired = getRequired(jsonSchema).sort();
    const zodRequired = ['requirements', 'tasks'].sort();
    expect(jsonRequired).toEqual(zodRequired);
  });

  it('Zod schema accepts valid ideate output', () => {
    const valid = {
      requirements: 'Implement search.',
      tasks: [{ name: 'Add search endpoint', projectPath: '/home/user/api' }],
    };
    expect(() => IdeateOutputSchema.parse(valid)).not.toThrow();
  });
});

// ─── Config schema ────────────────────────────────────────────────────────────

describe('config.schema.json ↔ AiProviderSchema', () => {
  const jsonSchema = loadJsonSchema('config.schema.json');
  const props = getProperties(jsonSchema);

  it('AiProvider enum values match (excluding null)', () => {
    const jsonEnum = getEnum(props, 'aiProvider', 'enum').filter((v) => v !== null);
    expect(jsonEnum).toEqual([...AiProviderSchema.options]);
  });
});
