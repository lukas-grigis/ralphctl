import { describe, expect, it } from 'vitest';
import { FixtureSchema } from '../../../../scripts/eval/fixture-schema.ts';
import { evaluateSpec } from '../../../fixtures/eval-harness.ts';

const messages = (spec: unknown): string =>
  FixtureSchema.safeParse(spec)
    .error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
    .join('\n') ?? '';

describe('FixtureSchema', () => {
  it('accepts a well-formed evaluate fixture', () => {
    expect(FixtureSchema.safeParse(evaluateSpec()).success).toBe(true);
  });

  it('rejects oracle.kind "none" without two named reviewers', () => {
    const one = { ...evaluateSpec(), oracle: { kind: 'none', reviewedBy: ['alice'] } };
    expect(FixtureSchema.safeParse(one).success).toBe(false);
    const zero = { ...evaluateSpec(), oracle: { kind: 'none', reviewedBy: [] } };
    expect(FixtureSchema.safeParse(zero).success).toBe(false);
  });

  it('rejects the same reviewer named twice', () => {
    const twice = { ...evaluateSpec(), oracle: { kind: 'none', reviewedBy: ['alice', 'alice'] } };
    expect(FixtureSchema.safeParse(twice).success).toBe(false);
  });

  it('accepts two distinct reviewers', () => {
    const two = { ...evaluateSpec(), oracle: { kind: 'none', reviewedBy: ['alice', 'bob'] } };
    expect(FixtureSchema.safeParse(two).success).toBe(true);
  });

  it('rejects a missing patch reference', () => {
    const spec = evaluateSpec() as { variants: Array<Record<string, unknown>> };
    spec.variants[0] = { name: 'clean', expect: { status: 'passed' } };
    expect(messages(spec)).toContain('variants.0.patch');
  });

  it('rejects duplicate variant names', () => {
    const spec = evaluateSpec() as { variants: Array<{ name: string }> };
    spec.variants[1] = { ...spec.variants[1], name: 'clean' } as never;
    expect(messages(spec)).toContain('variant names must be unique');
  });

  it('requires a failing variant to name its defect class', () => {
    const spec = evaluateSpec() as { variants: Array<Record<string, unknown>> };
    const { defectClass: _dropped, ...rest } = spec.variants[1] as { defectClass: string };
    void _dropped;
    spec.variants[1] = rest;
    expect(messages(spec)).toContain('must name its defectClass');
  });

  it('rejects an expectation about a criterion the task does not declare', () => {
    const spec = evaluateSpec() as { variants: Array<{ expect: Record<string, unknown> }> };
    spec.variants[1]!.expect = { status: 'failed', criteria: { C9: { passed: false } } };
    expect(messages(spec)).toContain("names 'C9'");
  });

  it('rejects an unknown floor dimension', () => {
    const spec = evaluateSpec() as { variants: Array<{ expect: Record<string, unknown> }> };
    spec.variants[1]!.expect = { status: 'failed', failedDimensions: ['style'] };
    expect(FixtureSchema.safeParse(spec).success).toBe(false);
  });

  it('holds the task to the planner schema: projectPath is not allowed, criteria must be well-formed', () => {
    const withPath = evaluateSpec() as { task: Record<string, unknown> };
    withPath.task = { ...withPath.task, projectPath: '/x' };
    expect(FixtureSchema.safeParse(withPath).success).toBe(false);

    const autoWithoutCommand = evaluateSpec() as { task: { verificationCriteria: Array<Record<string, unknown>> } };
    autoWithoutCommand.task = {
      ...autoWithoutCommand.task,
      verificationCriteria: [{ id: 'C1', assertion: 'x', check: 'auto' }],
    };
    expect(messages(autoWithoutCommand)).toContain('auto but has no command');
  });

  it('discriminates on flow', () => {
    expect(FixtureSchema.safeParse({ ...evaluateSpec(), flow: 'plan' }).success).toBe(false);
    const implementNoReference = {
      ...evaluateSpec(),
      flow: 'implement',
      variants: undefined,
      oracle: { command: 'x', protectedPaths: [] },
    };
    expect(messages(implementNoReference)).toContain('referencePatch');
  });

  it('holds oracle.protectedPaths inside the workspace: relative, no "." / ".." / empty segments', () => {
    const withPaths = (protectedPaths: string[]): unknown => ({
      ...evaluateSpec(),
      oracle: { command: 'x', protectedPaths },
    });
    for (const bad of [
      '../outside',
      'test/../../x',
      '..',
      '/etc',
      '/',
      '.',
      './',
      'test/./a.mjs',
      'test//a.mjs',
      '..\\x',
      'C:\\x',
      '',
    ]) {
      expect(FixtureSchema.safeParse(withPaths([bad])).success, JSON.stringify(bad)).toBe(false);
    }
    expect(messages(withPaths(['../outside']))).toContain('oracle.protectedPaths.0');
    expect(FixtureSchema.safeParse(withPaths(['test/clamp.test.mjs', 'test/', 'src/a..b.mjs'])).success).toBe(true);
  });

  it('rejects unknown top-level keys', () => {
    expect(FixtureSchema.safeParse({ ...evaluateSpec(), surprise: true }).success).toBe(false);
  });

  it('rejects a non-kebab id', () => {
    expect(FixtureSchema.safeParse({ ...evaluateSpec(), id: 'Bad_Id' }).success).toBe(false);
  });
});
