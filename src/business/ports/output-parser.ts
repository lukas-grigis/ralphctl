import type { ImportTask, RefinedRequirement } from '@src/domain/models.ts';

/** Evaluation dimension result */
export interface DimensionScore {
  dimension: string;
  status: 'PASS' | 'FAIL';
  description: string;
}

/** Parsed evaluation result */
export interface EvaluationParseResult {
  status: 'passed' | 'failed' | 'malformed';
  dimensions: DimensionScore[];
  rawOutput: string;
}

/** Parsed ideation result (requirements + tasks) */
export interface IdeationParseResult {
  requirements: string;
  tasks: ImportTask[];
}

/** Port for parsing AI output into structured data */
export interface OutputParserPort {
  /** Parse requirements from AI output */
  parseRequirements(output: string): RefinedRequirement[];

  /** Parse tasks JSON from AI output */
  parseTasks(output: string): ImportTask[];

  /** Parse ideation output (requirements + tasks) */
  parseIdeation(output: string): IdeationParseResult;

  /** Parse evaluation output into structured result */
  parseEvaluation(output: string): EvaluationParseResult;

  /** Check if output contains a planning-blocked signal */
  parsePlanningBlocked(output: string): string | null;

  /** Parse task execution signals (complete, blocked, verified) */
  parseExecutionSignals(output: string): {
    complete: boolean;
    blocked: string | null;
    verified: string | null;
  };
}
