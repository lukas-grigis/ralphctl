import type {
  DimensionScore,
  EvaluationParseResult,
  IdeationParseResult,
  OutputParserPort,
} from '@src/business/ports/output-parser.ts';
import type { ImportTask, RefinedRequirement } from '@src/domain/models.ts';
import { IdeateOutputSchema } from '@src/domain/models.ts';
import { parsePlanningBlocked, parseTasksJson } from '@src/integration/cli/commands/sprint/plan-utils.ts';
import { parseRequirementsFile } from '@src/integration/cli/commands/ticket/refine-utils.ts';
import { parseEvaluationResult } from '@src/integration/ai/evaluator.ts';
import { parseExecutionResult } from '@src/integration/ai/output/parser.ts';
import { extractJsonObject } from '@src/integration/utils/json-extract.ts';

export class DefaultOutputParserAdapter implements OutputParserPort {
  parseRequirements(output: string): RefinedRequirement[] {
    return parseRequirementsFile(output);
  }

  parseTasks(output: string): ImportTask[] {
    return parseTasksJson(output);
  }

  parseIdeation(output: string): IdeationParseResult {
    // Try to parse as structured ideation output (requirements + tasks object)
    try {
      const jsonStr = extractJsonObject(output);
      const parsed = JSON.parse(jsonStr) as unknown;
      const result = IdeateOutputSchema.safeParse(parsed);
      if (result.success) {
        return {
          requirements: result.data.requirements,
          tasks: result.data.tasks,
        };
      }
    } catch {
      // Fall through to bare tasks array parsing
    }

    // Fall back to bare tasks array (requirements treated as empty)
    const tasks = parseTasksJson(output);
    return {
      requirements: '',
      tasks,
    };
  }

  parseEvaluation(output: string): EvaluationParseResult {
    const result = parseEvaluationResult(output);
    const dimensions: DimensionScore[] = result.dimensions.map((d) => ({
      dimension: d.dimension,
      status: d.passed ? ('PASS' as const) : ('FAIL' as const),
      description: d.finding,
    }));

    return {
      status: result.status,
      dimensions,
      rawOutput: result.output,
    };
  }

  parsePlanningBlocked(output: string): string | null {
    return parsePlanningBlocked(output);
  }

  parseExecutionSignals(output: string): {
    complete: boolean;
    blocked: string | null;
    verified: string | null;
  } {
    const result = parseExecutionResult(output);
    return {
      complete: result.success,
      blocked: result.blockedReason ?? null,
      verified: result.verificationOutput ?? null,
    };
  }
}
