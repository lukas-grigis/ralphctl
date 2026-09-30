import { posix, win32 } from 'node:path';
import { z } from 'zod';
import { TaskImportSpecSchema } from '@src/integration/ai/prompts/_engine/task-import-schema.ts';

/**
 * Zod schema for `evals/fixtures/<flow>/<id>/fixture.json` — a discriminated union on `flow`.
 *
 * The `task` field reuses the planner's own output schema (`TaskImportSpecSchema`) minus
 * `projectPath`, so a fixture task is held to exactly what a planner-emitted task must satisfy.
 * Paths inside a fixture are relative to the fixture directory; the loader checks they exist.
 */

export const EVAL_FLOWS = ['evaluate', 'implement', 'detect-scripts', 'select-candidate'] as const;
export type EvalFlow = (typeof EVAL_FLOWS)[number];

/** The five floor dimensions the evaluator always grades (`floor-dimensions.ts`). */
export const FLOOR_DIMENSIONS = ['correctness', 'completeness', 'safety', 'consistency', 'robustness'] as const;

const TaskSpecSchema = TaskImportSpecSchema.omit({ projectPath: true });

const SCHEMA_VERSION = z.literal(1);
const NonEmpty = z.string().min(1);

/**
 * A `protectedPaths` entry. The oracle runner `rm -rf`s `<workspace>/<entry>` before restoring it, so
 * an entry that escapes the workspace (absolute, `..`) or names its root (`.`) would delete outside
 * the trial. Entries must also be normalized — `isProtectedPath` (grade.ts) compares them verbatim
 * against git's changed paths, so `./test` or `test//a` would never match. A single trailing `/`
 * marks a directory (`test/`).
 */
const ProtectedPath = NonEmpty.refine((p) => !posix.isAbsolute(p) && !win32.isAbsolute(p), {
  message: 'must be relative to the fixture repo',
}).refine(
  (p) =>
    p
      .replace(/[\\/]$/, '')
      .split(/[\\/]/)
      .every((seg) => seg !== '' && seg !== '.' && seg !== '..'),
  {
    message:
      'must be a normalized path inside the fixture repo — no ".", ".." or empty segments (a trailing "/" marks a directory)',
  }
);

/** Command oracle: hidden checks run inside the materialized workspace; `protectedPaths` are restored first. */
const CommandOracleSchema = z
  .object({
    command: NonEmpty,
    protectedPaths: z.array(ProtectedPath).default([]),
  })
  .strict();

/**
 * Reviewer-labelled oracle — only for verdicts a command cannot prove (UNVERIFIED, spec-ambiguity).
 * Needs two distinct named reviewers, mirroring "two domain experts would independently reach the
 * same pass/fail verdict" (Anthropic, Demystifying evals).
 */
const NoOracleSchema = z
  .object({
    kind: z.literal('none'),
    reviewedBy: z.array(NonEmpty).min(2, 'oracle.kind "none" needs at least two named reviewers'),
  })
  .strict()
  .refine((o) => new Set(o.reviewedBy).size === o.reviewedBy.length, {
    message: 'oracle.reviewedBy entries must be distinct people',
    path: ['reviewedBy'],
  });

const EvaluateOracleSchema = z.union([CommandOracleSchema, NoOracleSchema]);

const ExpectSchema = z
  .object({
    status: z.enum(['passed', 'failed']),
    failedDimensions: z.array(z.enum(FLOOR_DIMENSIONS)).optional(),
    criteria: z
      .record(
        z.string(),
        z
          .object({
            passed: z.boolean().optional(),
            evidencePrefix: z.literal('UNVERIFIED:').optional(),
          })
          .strict()
      )
      .optional(),
    critiqueMarkers: z.array(NonEmpty).optional(),
  })
  .strict();

const VariantSchema = z
  .object({
    name: NonEmpty,
    patch: NonEmpty,
    defectClass: NonEmpty.optional(),
    expect: ExpectSchema,
  })
  .strict();

const CommonShape = {
  schemaVersion: SCHEMA_VERSION,
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be lowercase kebab-case'),
  tier: z.enum(['regression', 'capability']),
  /** Repo family — the unit of independence for clustered standard errors. */
  cluster: NonEmpty,
  origin: z.enum(['synthetic', 'real']),
  provenance: NonEmpty,
};

const TaskShape = {
  task: TaskSpecSchema,
  verifyScript: NonEmpty.optional(),
  projectTooling: NonEmpty.optional(),
};

const EvaluateFixtureSchema = z
  .object({
    ...CommonShape,
    flow: z.literal('evaluate'),
    ...TaskShape,
    variants: z.array(VariantSchema).min(1),
    oracle: EvaluateOracleSchema,
  })
  .strict()
  .superRefine((f, ctx) => {
    const names = f.variants.map((v) => v.name);
    if (new Set(names).size !== names.length) {
      ctx.addIssue({ code: 'custom', message: 'variant names must be unique', path: ['variants'] });
    }
    f.variants.forEach((v, i) => {
      if (v.expect.status === 'failed' && v.defectClass === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: `variant '${v.name}' expects a failing verdict, so it must name its defectClass`,
          path: ['variants', i, 'defectClass'],
        });
      }
    });
    const criterionIds = new Set(f.task.verificationCriteria.map((c) => c.id));
    f.variants.forEach((v, i) => {
      for (const id of Object.keys(v.expect.criteria ?? {})) {
        if (!criterionIds.has(id)) {
          ctx.addIssue({
            code: 'custom',
            message: `expect.criteria names '${id}', which the task does not declare`,
            path: ['variants', i, 'expect', 'criteria', id],
          });
        }
      }
    });
  });

const ImplementFixtureSchema = z
  .object({
    ...CommonShape,
    flow: z.literal('implement'),
    ...TaskShape,
    /**
     * Reference solution — "a known working output that passes all graders" (Anthropic). `check`
     * proves the task is solvable by applying it and running the oracle; it never reaches the model.
     */
    referencePatch: NonEmpty,
    oracle: CommandOracleSchema,
  })
  .strict();

const DetectScriptsFixtureSchema = z
  .object({
    ...CommonShape,
    flow: z.literal('detect-scripts'),
    /** Patch that makes the repo's real test suite fail — the proposed verify script must then exit non-zero. */
    brokenPatch: NonEmpty,
    /** Informational only — never part of `correct`. */
    expected: z.object({ verifyScript: NonEmpty.optional() }).strict().optional(),
    /** Wall-clock cap for each run of the proposed script (ms). */
    commandTimeoutMs: z.number().int().positive().default(120_000),
  })
  .strict();

const CandidateSchema = z.object({ summary: NonEmpty, patch: NonEmpty }).strict();

const SelectCandidateFixtureSchema = z
  .object({
    ...CommonShape,
    flow: z.literal('select-candidate'),
    task: TaskSpecSchema,
    candidates: z.object({ a: CandidateSchema, b: CandidateSchema }).strict(),
    winner: z.enum(['a', 'b']),
    oracle: CommandOracleSchema,
  })
  .strict();

export const FixtureSchema = z.discriminatedUnion('flow', [
  EvaluateFixtureSchema,
  ImplementFixtureSchema,
  DetectScriptsFixtureSchema,
  SelectCandidateFixtureSchema,
]);

export type FixtureSpec = z.infer<typeof FixtureSchema>;
export type EvaluateFixtureSpec = Extract<FixtureSpec, { flow: 'evaluate' }>;
export type ImplementFixtureSpec = Extract<FixtureSpec, { flow: 'implement' }>;
export type DetectScriptsFixtureSpec = Extract<FixtureSpec, { flow: 'detect-scripts' }>;
export type SelectCandidateFixtureSpec = Extract<FixtureSpec, { flow: 'select-candidate' }>;
export type EvaluateExpect = z.infer<typeof ExpectSchema>;
export type EvaluateVariantSpec = z.infer<typeof VariantSchema>;
export type CommandOracle = z.infer<typeof CommandOracleSchema>;
export type TaskSpec = z.infer<typeof TaskSpecSchema>;
