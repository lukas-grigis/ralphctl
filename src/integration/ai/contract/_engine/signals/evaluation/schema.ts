import { z } from 'zod';
import type { EvaluationSignal, DimensionScore } from '@src/domain/signal.ts';
import { IsoTimestampSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import type { Compatible } from '@src/integration/persistence/shared/codec-internal.ts';

/**
 * Per-dimension PASS / FAIL verdict the evaluator emits. The redesign dropped the numeric
 * `score` field — `passed` is the only verdict per dimension. Two refinements protect
 * downstream consumers:
 *
 *  - `passed === false` REQUIRES `finding` to be non-empty so the operator (and the next
 *    generator turn's prompt) always has a concrete reason for the FAIL.
 *  - `executionEvidence` is schema-optional. Auto criteria are prompt-enforced to fill it;
 *    making it Zod-required would require cross-referencing `tasks.json` from the signal
 *    schema (ugly cross-aggregate coupling). The anti-rubber-stamp guard in the evaluator
 *    template is the primary enforcer; operators catch violations in `evaluation.md`.
 */
const dimensionScoreSchema = z
  .object({
    dimension: z.string(),
    passed: z.boolean(),
    finding: z.string(),
    executionEvidence: z.string().optional(),
  })
  .superRefine((d, ctx) => {
    if (!d.passed && d.finding.trim().length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: `dimension '${d.dimension}' failed but carries no finding`,
        path: ['finding'],
      });
    }
  });

const _dimensionTypeCheck: Compatible<z.infer<typeof dimensionScoreSchema>, DimensionScore> = true;
void _dimensionTypeCheck;

/**
 * Zod schema for the `evaluation` AI signal — the evaluator's verdict + per-dimension
 * findings. PASS / FAIL only (no numeric score, no `overallScore`).
 *
 * The signal-level refinement enforces verdict / dimension consistency:
 *  - `status: 'passed'`  → every dimension MUST be `passed: true`.
 *  - `status: 'failed'`  → at least one dimension MUST be `passed: false`.
 *  - `status: 'malformed'` is the escape hatch the harness uses when the AI emits dimension
 *     rows but no terminal verdict; no consistency check applies.
 */
export const evaluationSignalSchema = z
  .object({
    type: z.literal('evaluation'),
    status: z.union([z.literal('passed'), z.literal('failed'), z.literal('malformed')]),
    dimensions: z.array(dimensionScoreSchema).readonly(),
    critique: z.string().optional(),
    timestamp: IsoTimestampSchema,
  })
  .superRefine((s, ctx) => {
    if (s.status === 'passed') {
      const failedIndex = s.dimensions.findIndex((d) => !d.passed);
      if (failedIndex !== -1) {
        ctx.addIssue({
          code: 'custom',
          message: 'status is "passed" but at least one dimension failed',
          path: ['dimensions', failedIndex, 'passed'],
        });
      }
    } else if (s.status === 'failed') {
      const anyFailed = s.dimensions.some((d) => !d.passed);
      if (!anyFailed) {
        ctx.addIssue({
          code: 'custom',
          message: 'status is "failed" but every dimension passed',
          path: ['status'],
        });
      }
    }
  });

const _typeCheck: Compatible<z.infer<typeof evaluationSignalSchema>, EvaluationSignal> = true;
void _typeCheck;
