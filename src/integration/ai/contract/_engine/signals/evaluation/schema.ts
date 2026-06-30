import { z } from 'zod';
import {
  FLOOR_DIMENSIONS,
  type CriterionVerdict,
  type DimensionScore,
  type EvaluationSignal,
} from '@src/domain/signal.ts';
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
 * Structured per-criterion verdict — the machine-readable PASS / FAIL of one task-specific
 * acceptance criterion, keyed by its contract id. `evidence` is schema-optional (a one-line
 * citation backing the verdict); the prompt asks for it, the schema does not force it so a terse
 * evaluator emission still validates.
 */
const criterionVerdictSchema = z.object({
  id: z.string().min(1),
  passed: z.boolean(),
  evidence: z.string().optional(),
});

const _criterionTypeCheck: Compatible<z.infer<typeof criterionVerdictSchema>, CriterionVerdict> = true;
void _criterionTypeCheck;

/**
 * Zod schema for the `evaluation` AI signal — the evaluator's verdict + per-dimension
 * findings. PASS / FAIL only (no numeric score, no `overallScore`).
 *
 * The signal-level refinement enforces verdict / dimension consistency AND the floor-dimension
 * coverage the prompt prose mandates:
 *  - `status: 'passed'`  → every dimension MUST be `passed: true` AND all four
 *     {@link FLOOR_DIMENSIONS} (correctness / completeness / safety / consistency) MUST be
 *     present. A "passed with zero dimensions" (or a partial floor set) is rejected here — the
 *     hole that previously let a vacuous PASS validate while the rubric lived in prompt-prose only.
 *  - `status: 'failed'`  → at least one dimension MUST be `passed: false` AND all four floor
 *     dimensions MUST be present (so the critique can name a concrete failing floor item).
 *  - `status: 'malformed'` is the escape hatch the harness uses when the AI emits dimension
 *     rows but no terminal verdict; no consistency or coverage check applies — the harness
 *     retries the attempt (see `prompts/evaluate/template.md`).
 *
 * The `criteria` array is ADDITIVE — structured per-criterion verdicts keyed by contract id,
 * orthogonal to the floor `dimensions`. Optional so legacy evaluator output still validates; when a
 * `status: 'passed'` signal lists criteria, EVERY listed criterion must be `passed: true` (a
 * "passed but a criterion failed" payload is internally inconsistent and is rejected here).
 */
export const evaluationSignalSchema = z
  .object({
    type: z.literal('evaluation'),
    status: z.union([z.literal('passed'), z.literal('failed'), z.literal('malformed')]),
    dimensions: z.array(dimensionScoreSchema).readonly(),
    criteria: z.array(criterionVerdictSchema).readonly().optional(),
    critique: z.string().optional(),
    timestamp: IsoTimestampSchema,
  })
  .superRefine((s, ctx) => {
    if (s.status === 'malformed') return;

    // A terminal `passed` cannot coexist with a failing listed criterion — the per-criterion
    // verdicts and the overall status would contradict each other. (An unlisted criterion is
    // simply ungraded this round, so coverage is NOT forced here — only consistency of what IS
    // listed.)
    if (s.status === 'passed' && s.criteria !== undefined) {
      const failedCriterionIndex = s.criteria.findIndex((c) => !c.passed);
      if (failedCriterionIndex !== -1) {
        ctx.addIssue({
          code: 'custom',
          message: 'status is "passed" but at least one listed criterion is marked failed',
          path: ['criteria', failedCriterionIndex, 'passed'],
        });
      }
    }

    // Floor-dimension coverage applies to BOTH terminal verdicts. The names are matched
    // case-/whitespace-insensitively, mirroring `failedDimensions` in the plateau predicate.
    const present = new Set(s.dimensions.map((d) => d.dimension.trim().toLowerCase()));
    const missing = FLOOR_DIMENSIONS.filter((name) => !present.has(name));
    if (missing.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: `status is "${s.status}" but the required floor dimension(s) ${missing.join(', ')} are missing — every terminal verdict must grade correctness, completeness, safety, and consistency`,
        path: ['dimensions'],
      });
    }

    if (s.status === 'passed') {
      const failedIndex = s.dimensions.findIndex((d) => !d.passed);
      if (failedIndex !== -1) {
        ctx.addIssue({
          code: 'custom',
          message: 'status is "passed" but at least one dimension failed',
          path: ['dimensions', failedIndex, 'passed'],
        });
      }
    } else {
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
