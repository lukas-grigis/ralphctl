import type { AiProvider } from '@src/domain/entity/settings.ts';
import type { EvalFlow, FixtureSpec } from './fixture-schema.ts';
import type { StopReason } from './budget.ts';

/** A loaded fixture: the parsed `fixture.json` plus the absolute directory it lives in. */
export type Fixture = FixtureSpec & { readonly dir: string };

/** The provider / model / effort a flow's session runs on, after preset + override resolution. */
export interface ResolvedRow {
  readonly provider: AiProvider;
  readonly model: string;
  readonly effort?: string;
}

/**
 * One experiment arm. Rows differ per flow (evaluate uses `implement.evaluator`, detect-scripts
 * `readiness`, …) so the arm carries all four; `templatesDir` swaps the prompt text at the
 * `TemplateLoader` port and is absent for the checked-out prompts.
 */
export interface ArmConfig {
  readonly name: string;
  /** Preset name, or `override` when `--provider/--model` replaced every row. */
  readonly label: string;
  readonly rows: Readonly<Record<EvalFlow, ResolvedRow>>;
  readonly templatesDir?: string;
  readonly templatesHash?: string;
}

/** Signal-level facts the graders read; the raw signals stay in `signals.json` on disk. */
export interface EvaluateGrade {
  readonly flow: 'evaluate';
  readonly correct: boolean;
  readonly structurallyValid: boolean;
  readonly status: string | null;
  readonly dimensionHit: boolean | null;
  readonly criteriaMatch: Readonly<Record<string, boolean>>;
  readonly unverifiedCompliance: boolean | null;
  readonly missingCriteria: readonly string[];
  readonly markerHit: boolean | null;
}

export interface ImplementGrade {
  readonly flow: 'implement';
  readonly correct: boolean;
  readonly structurallyValid: boolean;
  readonly oraclePassed: boolean;
  readonly protectedPathsTouched: readonly string[];
  /** The model claimed completion (`task-complete` / `task-verified`) but the oracle failed. */
  readonly falseCompletion: boolean;
}

export interface DetectScriptsGrade {
  readonly flow: 'detect-scripts';
  readonly correct: boolean;
  readonly structurallyValid: boolean;
  readonly proposed: string | null;
  readonly cleanPasses: boolean | null;
  readonly brokenFails: boolean | null;
  readonly exactMatch: boolean | null;
}

export interface SelectCandidateGrade {
  readonly flow: 'select-candidate';
  readonly correct: boolean;
  readonly structurallyValid: boolean;
  /** Which candidate the judge picked; `tie` = winner 0; `none` = no usable verdict. */
  readonly picked: 'a' | 'b' | 'tie' | 'none';
}

export type Grade = EvaluateGrade | ImplementGrade | DetectScriptsGrade | SelectCandidateGrade;

export interface TrialUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** Cache-read / cache-write prompt tokens; `null`/absent = never reported (also absent in pre-cache results files). */
  readonly cacheReadTokens?: number | null;
  readonly cacheCreationTokens?: number | null;
  readonly durationMs: number;
  /** Every spawn of the trial (primary + corrective nudges) reported both token counts. */
  readonly metered: boolean;
}

export interface TrialRecord {
  readonly fixtureId: string;
  readonly flow: EvalFlow;
  /** Variant name; for select-candidate the candidate order (`ab` / `ba`). */
  readonly variant: string;
  readonly trialIndex: number;
  readonly arm: string;
  readonly tier: 'regression' | 'capability';
  readonly cluster: string;
  readonly origin: 'synthetic' | 'real';
  readonly defectClass?: string;
  /** False when the trial could not be graded for an infrastructure reason — excluded from stats. */
  readonly graded: boolean;
  readonly correct: boolean;
  readonly structurallyValid: boolean;
  /** Corrective nudges consumed; `null` when no validation ran. `0` = first try was schema-valid. */
  readonly nudgeCount: number | null;
  readonly usage: TrialUsage;
  readonly grade?: Grade;
  readonly error?: string;
  /** Artifact directory, relative to the run directory. */
  readonly artifactDir: string;
}

export interface MetricRow {
  readonly name: string;
  readonly n: number;
  readonly mean: number;
  readonly se: number | null;
  readonly ci: readonly [number, number] | null;
  readonly approx: boolean;
}

/** Cost roll-up for one flow × arm. Token means / totals are `null` when no trial reported them (never imputed). */
export interface UsageSummary {
  readonly trials: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheCreationTokens: number | null;
  readonly meanInputTokens: number | null;
  readonly meanOutputTokens: number | null;
  readonly meanCacheReadTokens: number | null;
  readonly meanCacheCreationTokens: number | null;
  readonly wallMs: number;
  readonly meanWallMs: number;
  readonly unmeteredTrials: number;
}

export interface ComparisonRow {
  readonly flow: EvalFlow;
  readonly metric: string;
  readonly n: number;
  readonly meanDiff: number;
  readonly se: number;
  readonly ci: readonly [number, number];
  readonly detectable: boolean;
  /** Fewer than `APPROX_MIN_ITEMS` paired items — the CI is flagged approximate. */
  readonly approx: boolean;
  /** Minimum detectable effect at this n (α = .05, power .8). */
  readonly mde: number;
}

export interface ResultsFile {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly stoppedReason: 'completed' | StopReason | 'aborted' | 'errors';
  readonly gitSha: string | null;
  readonly gitDirty: boolean | null;
  readonly k: number;
  readonly fixtureSetHash: string;
  readonly dryRun: boolean;
  readonly arms: readonly ArmConfig[];
  readonly budget: {
    readonly maxTokens: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheCreationTokens: number;
    readonly unmeteredTrials: number;
    readonly wallMs: number;
  };
  readonly trials: readonly TrialRecord[];
  /** flow → arm name → metrics. */
  readonly metrics: Readonly<Record<string, Readonly<Record<string, readonly MetricRow[]>>>>;
  /** flow → arm name → usage roll-up. */
  readonly usage: Readonly<Record<string, Readonly<Record<string, UsageSummary>>>>;
  /** `<arm>:<item>` for every item with fewer graded trials than expected — left out of stats and pairing. */
  readonly incompleteItems: readonly string[];
  readonly comparison?: readonly ComparisonRow[];
  readonly notes: readonly string[];
}
