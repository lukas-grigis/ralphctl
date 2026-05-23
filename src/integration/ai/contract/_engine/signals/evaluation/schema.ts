import { z } from 'zod';
import type { EvaluationSignal, DimensionScore } from '@src/domain/signal.ts';
import { IsoTimestampSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import type { Compatible } from '@src/integration/persistence/shared/codec-internal.ts';

const dimensionScoreSchema = z.object({
  dimension: z.string(),
  score: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  passed: z.boolean(),
  finding: z.string(),
});

const _dimensionTypeCheck: Compatible<z.infer<typeof dimensionScoreSchema>, DimensionScore> = true;
void _dimensionTypeCheck;

/**
 * Zod schema for the `evaluation` AI signal — the evaluator's verdict + per-dimension
 * findings. Matches today's domain shape (`status: 'passed' | 'failed' | 'malformed'`,
 * `dimensions: DimensionScore[]`, `overallScore?`, `critique?`); when the evaluator leaf
 * migrates to the new contract in step [09] the shape may evolve and the schema moves with
 * the type.
 */
/** @public */
export const evaluationSignalSchema = z.object({
  type: z.literal('evaluation'),
  status: z.union([z.literal('passed'), z.literal('failed'), z.literal('malformed')]),
  dimensions: z.array(dimensionScoreSchema).readonly(),
  overallScore: z.number().optional(),
  critique: z.string().optional(),
  timestamp: IsoTimestampSchema,
});

const _typeCheck: Compatible<z.infer<typeof evaluationSignalSchema>, EvaluationSignal> = true;
void _typeCheck;
